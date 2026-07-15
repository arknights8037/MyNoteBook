use serde::Deserialize;
use serde_json::Value;
use sqlx::Row;
use tauri::AppHandle;

use crate::database::{database_error, open_database};
use crate::domain_events::{record_with_outbox, NewDomainEvent};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDependencyInput {
    source_type: String,
    knowledge_object_id: Option<String>,
    document_id: Option<String>,
    block_id: Option<String>,
    source_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitViewRefreshInput {
    data_directory: Option<String>,
    view_id: String,
    expected_version: i64,
    snapshot_id: String,
    source_snapshot_hash: String,
    render_json: String,
    dependencies: Vec<ViewDependencyInput>,
    provider: Option<String>,
    model: Option<String>,
    #[serde(default)]
    skill_versions: Vec<Value>,
    generated_at: Option<i64>,
    correlation_id: Option<String>,
    causation_id: Option<String>,
    event_id: String,
    outbox_id: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetViewManualOverrideInput {
    data_directory: Option<String>,
    view_id: String,
    expected_version: i64,
    content_json: String,
    correlation_id: String,
    event_id: String,
    outbox_id: String,
    updated_at: i64,
}

#[tauri::command]
pub async fn commit_view_refresh(
    app: AppHandle,
    input: CommitViewRefreshInput,
) -> Result<(), String> {
    let pool = open_database(&app, input.data_directory.clone()).await?;
    commit_view_refresh_in_pool(pool.as_ref(), &input).await
}

async fn commit_view_refresh_in_pool(
    pool: &sqlx::SqlitePool,
    input: &CommitViewRefreshInput,
) -> Result<(), String> {
    if input.source_snapshot_hash.len() != 64
        || !input
            .source_snapshot_hash
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("View snapshot hash 无效。".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&input.render_json)
        .map_err(|error| format!("View render JSON 无效：{error}"))?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let row = sqlx::query(
        "SELECT view_type, version, manual_override FROM view_definitions WHERE id = ? LIMIT 1",
    )
    .bind(&input.view_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| "View Definition 不存在。".to_string())?;
    let view_type: String = row.try_get("view_type").map_err(database_error)?;
    let version: i64 = row.try_get("version").map_err(database_error)?;
    let manual_override: bool = row.try_get("manual_override").map_err(database_error)?;
    if !matches!(view_type.as_str(), "query" | "projection" | "generated")
        || version != input.expected_version
    {
        return Err("View Definition 类型或版本已变化。".to_string());
    }
    if view_type == "generated"
        && (input.provider.as_deref().unwrap_or("").trim().is_empty()
            || input.model.as_deref().unwrap_or("").trim().is_empty()
            || input.generated_at.is_none())
    {
        return Err("Generated View provenance 不完整。".to_string());
    }
    let protected_by_override = view_type == "generated" && manual_override;
    let snapshot_status = if protected_by_override {
        "preview"
    } else {
        "fresh"
    };
    let skill_versions_json =
        serde_json::to_string(&input.skill_versions).map_err(|error| error.to_string())?;
    sqlx::query(
        "INSERT INTO view_snapshots (id, view_id, status, source_snapshot_hash, render_json, \
         provider, model, skill_versions_json, generated_at, protected_by_override, \
         correlation_id, causation_id, error, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(&input.snapshot_id)
    .bind(&input.view_id)
    .bind(snapshot_status)
    .bind(&input.source_snapshot_hash)
    .bind(&input.render_json)
    .bind(&input.provider)
    .bind(&input.model)
    .bind(&skill_versions_json)
    .bind(input.generated_at)
    .bind(protected_by_override)
    .bind(&input.correlation_id)
    .bind(&input.causation_id)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    for dependency in &input.dependencies {
        if dependency.source_revision < 1 {
            return Err("View dependency revision 必须大于 0。".to_string());
        }
        match dependency.source_type.as_str() {
            "knowledge_object"
                if dependency.knowledge_object_id.is_some()
                    && dependency.document_id.is_none()
                    && dependency.block_id.is_none() => {}
            "document_block"
                if dependency.document_id.is_some() && dependency.knowledge_object_id.is_none() => {
            }
            _ => return Err("View dependency 来源无效。".to_string()),
        }
        sqlx::query(
            "INSERT INTO view_dependencies (snapshot_id, view_id, source_type, knowledge_object_id, \
             document_id, block_id, source_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&input.snapshot_id)
        .bind(&input.view_id)
        .bind(&dependency.source_type)
        .bind(&dependency.knowledge_object_id)
        .bind(&dependency.document_id)
        .bind(&dependency.block_id)
        .bind(dependency.source_revision)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    let updated = if protected_by_override {
        sqlx::query(
            "UPDATE view_definitions SET last_refreshed_at = ?, updated_at = ? \
             WHERE id = ? AND version = ?",
        )
        .bind(input.created_at)
        .bind(input.created_at)
        .bind(&input.view_id)
        .bind(input.expected_version)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
    } else {
        sqlx::query(
            "UPDATE view_definitions SET stale = 0, current_snapshot_id = ?, \
             last_refreshed_at = ?, updated_at = ? WHERE id = ? AND version = ?",
        )
        .bind(&input.snapshot_id)
        .bind(input.created_at)
        .bind(input.created_at)
        .bind(&input.view_id)
        .bind(input.expected_version)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
    };
    if updated.rows_affected() != 1 {
        return Err("View Definition 在刷新时发生变化。".to_string());
    }
    let payload = serde_json::json!({
        "viewId": input.view_id,
        "snapshotId": input.snapshot_id,
        "status": snapshot_status,
        "protectedByOverride": protected_by_override
    });
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &input.event_id,
            outbox_id: &input.outbox_id,
            event_type: "view.refreshed",
            aggregate_type: "view",
            aggregate_id: &input.view_id,
            payload: &payload,
            actor_id: "local_user",
            correlation_id: input.correlation_id.as_deref().unwrap_or(&input.event_id),
            causation_id: input.causation_id.as_deref(),
            occurred_at: input.created_at,
        },
    )
    .await?;
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
pub async fn set_view_manual_override(
    app: AppHandle,
    input: SetViewManualOverrideInput,
) -> Result<(), String> {
    let pool = open_database(&app, input.data_directory.clone()).await?;
    set_view_manual_override_in_pool(pool.as_ref(), &input).await
}

async fn set_view_manual_override_in_pool(
    pool: &sqlx::SqlitePool,
    input: &SetViewManualOverrideInput,
) -> Result<(), String> {
    let content: Value = serde_json::from_str(&input.content_json)
        .map_err(|error| format!("View override JSON 无效：{error}"))?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let updated = sqlx::query(
        "UPDATE view_definitions SET manual_override = 1, override_content_json = ?, \
         override_updated_at = ?, version = version + 1, updated_at = ? \
         WHERE id = ? AND view_type = 'generated' AND version = ?",
    )
    .bind(&input.content_json)
    .bind(input.updated_at)
    .bind(input.updated_at)
    .bind(&input.view_id)
    .bind(input.expected_version)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Generated View 已变化或不存在。".to_string());
    }
    let event_payload = serde_json::json!({ "viewId": input.view_id, "content": content });
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &input.event_id,
            outbox_id: &input.outbox_id,
            event_type: "view.overridden",
            aggregate_type: "view",
            aggregate_id: &input.view_id,
            payload: &event_payload,
            actor_id: "local_user",
            correlation_id: &input.correlation_id,
            causation_id: None,
            occurred_at: input.updated_at,
        },
    )
    .await?;
    transaction.commit().await.map_err(database_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn isolated_data_directory_restores_knowledge_validation_and_protected_view_override() {
        let directory = std::env::temp_dir().join(format!(
            "my-notebook-view-smoke-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        crate::database::prepare_database_path(&directory, &crate::database::DATABASE_MIGRATOR)
            .await
            .expect("prepare isolated database");
        let database_path = directory.join(crate::database::DATABASE_FILENAME);
        let pool = crate::database::get_pool_for_path(&database_path, false)
            .await
            .expect("open isolated database");

        sqlx::query(
            "INSERT INTO documents (id, title, content_json, plain_text, schema_version, revision, \
             sort_order, is_deleted, created_at, updated_at, document_kind) \
             VALUES ('view-smoke-document', 'G0 isolated source', \
             '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"attrs\":{\"id\":\"view-smoke-block\"},\"content\":[{\"type\":\"text\",\"text\":\"isolated source\"}]}]}', \
             'isolated source', 2, 1, 0, 0, 1, 1, 'article')",
        )
        .execute(pool.as_ref())
        .await
        .expect("source document");
        sqlx::query(
            "INSERT INTO blocks (document_id, id, block_type, block_index, content_json, \
             plain_text, document_revision, updated_at) VALUES ('view-smoke-document', \
             'view-smoke-block', 'paragraph', 0, \
             '{\"type\":\"paragraph\",\"attrs\":{\"id\":\"view-smoke-block\"},\"content\":[{\"type\":\"text\",\"text\":\"isolated source\"}]}', \
             'isolated source', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("source block");
        sqlx::query(
            "INSERT INTO knowledge_objects (id, object_type, status, title, content, \
             structured_data_json, cognitive_mode, template_id, template_version, authority_level, \
             confidence, document_id, block_id, source_revision, version, created_at, updated_at) \
             VALUES ('view-smoke-knowledge', 'claim', 'approved', 'Isolated claim', \
             'Only used by the G0 smoke.', '{\"isolated\":true}', 'research', \
             'knowledge-control-default', 1, 'local', 0.9, 'view-smoke-document', \
             'view-smoke-block', 1, 1, 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("knowledge object");
        sqlx::query(
            "INSERT INTO knowledge_object_sources (id, knowledge_object_id, document_id, block_id, \
             revision, quote, created_at) VALUES ('view-smoke-source', 'view-smoke-knowledge', \
             'view-smoke-document', 'view-smoke-block', 1, 'isolated source', 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("knowledge source");
        sqlx::query(
            "INSERT INTO knowledge_validations (id, knowledge_object_id, rule_id, verdict, \
             severity, message, source_json, validated_at) \
             VALUES ('view-smoke-validation', 'view-smoke-knowledge', 'isolated-source', \
             'passed', 'info', 'Source revision is available.', \
             '{\"documentId\":\"view-smoke-document\"}', 2)",
        )
        .execute(pool.as_ref())
        .await
        .expect("knowledge validation");
        sqlx::query(
            "INSERT INTO view_definitions (id, name, view_type, scope_query_json, \
             render_spec_json, writeback_policy, generation_prompt, generation_provider, \
             generation_model, created_at, updated_at) \
             VALUES ('view-smoke-generated', 'G0 isolated generated view', 'generated', \
             '{\"knowledgeObjectIds\":[\"view-smoke-knowledge\"]}', '{}', 'readonly', \
             'Render isolated source.', 'deepseek', 'smoke-model', 3, 3)",
        )
        .execute(pool.as_ref())
        .await
        .expect("view definition");

        commit_view_refresh_in_pool(
            pool.as_ref(),
            &CommitViewRefreshInput {
                data_directory: None,
                view_id: "view-smoke-generated".to_string(),
                expected_version: 1,
                snapshot_id: "view-smoke-snapshot-1".to_string(),
                source_snapshot_hash: "a".repeat(64),
                render_json: "{\"content\":\"generated v1\"}".to_string(),
                dependencies: vec![ViewDependencyInput {
                    source_type: "knowledge_object".to_string(),
                    knowledge_object_id: Some("view-smoke-knowledge".to_string()),
                    document_id: None,
                    block_id: None,
                    source_revision: 1,
                }],
                provider: Some("deepseek".to_string()),
                model: Some("smoke-model".to_string()),
                skill_versions: vec![serde_json::json!({"id":"g0-smoke","version":"1"})],
                generated_at: Some(4),
                correlation_id: Some("view-smoke-correlation".to_string()),
                causation_id: None,
                event_id: "view-smoke-refresh-1-event".to_string(),
                outbox_id: "view-smoke-refresh-1-outbox".to_string(),
                created_at: 4,
            },
        )
        .await
        .expect("initial view refresh");
        set_view_manual_override_in_pool(
            pool.as_ref(),
            &SetViewManualOverrideInput {
                data_directory: None,
                view_id: "view-smoke-generated".to_string(),
                expected_version: 1,
                content_json: "{\"content\":\"manual protected content\"}".to_string(),
                correlation_id: "view-smoke-correlation".to_string(),
                event_id: "view-smoke-override-event".to_string(),
                outbox_id: "view-smoke-override-outbox".to_string(),
                updated_at: 5,
            },
        )
        .await
        .expect("manual override");
        commit_view_refresh_in_pool(
            pool.as_ref(),
            &CommitViewRefreshInput {
                data_directory: None,
                view_id: "view-smoke-generated".to_string(),
                expected_version: 2,
                snapshot_id: "view-smoke-snapshot-2".to_string(),
                source_snapshot_hash: "b".repeat(64),
                render_json: "{\"content\":\"generated v2 preview\"}".to_string(),
                dependencies: vec![ViewDependencyInput {
                    source_type: "knowledge_object".to_string(),
                    knowledge_object_id: Some("view-smoke-knowledge".to_string()),
                    document_id: None,
                    block_id: None,
                    source_revision: 1,
                }],
                provider: Some("deepseek".to_string()),
                model: Some("smoke-model".to_string()),
                skill_versions: Vec::new(),
                generated_at: Some(6),
                correlation_id: Some("view-smoke-correlation".to_string()),
                causation_id: None,
                event_id: "view-smoke-refresh-2-event".to_string(),
                outbox_id: "view-smoke-refresh-2-outbox".to_string(),
                created_at: 6,
            },
        )
        .await
        .expect("protected preview refresh");

        drop(pool);
        crate::database::close_pool(&database_path)
            .await
            .expect("close isolated database");
        let reopened = crate::database::get_pool_for_path(&database_path, false)
            .await
            .expect("reopen isolated database");
        let definition = sqlx::query(
            "SELECT manual_override, override_content_json, current_snapshot_id, version \
             FROM view_definitions WHERE id = 'view-smoke-generated'",
        )
        .fetch_one(reopened.as_ref())
        .await
        .expect("restored definition");
        assert_eq!(definition.try_get::<i64, _>("manual_override").unwrap(), 1);
        assert!(definition
            .try_get::<String, _>("override_content_json")
            .unwrap()
            .contains("manual protected content"));
        assert_eq!(
            definition
                .try_get::<String, _>("current_snapshot_id")
                .unwrap(),
            "view-smoke-snapshot-1"
        );
        assert_eq!(definition.try_get::<i64, _>("version").unwrap(), 2);
        let preview = sqlx::query(
            "SELECT status, protected_by_override FROM view_snapshots \
             WHERE id = 'view-smoke-snapshot-2'",
        )
        .fetch_one(reopened.as_ref())
        .await
        .expect("restored preview");
        assert_eq!(preview.try_get::<String, _>("status").unwrap(), "preview");
        assert_eq!(
            preview.try_get::<i64, _>("protected_by_override").unwrap(),
            1
        );
        let validation_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_validations \
             WHERE knowledge_object_id = 'view-smoke-knowledge' AND verdict = 'passed'",
        )
        .fetch_one(reopened.as_ref())
        .await
        .expect("restored validation");
        assert_eq!(validation_count, 1);
        let foreign_key_errors: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(reopened.as_ref())
                .await
                .expect("foreign key check");
        assert!(foreign_key_errors.is_empty());

        drop(reopened);
        crate::database::close_pool(&database_path)
            .await
            .expect("close reopened database");
        let _ = std::fs::remove_dir_all(directory);
    }
}
