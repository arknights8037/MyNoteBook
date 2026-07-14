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
    let pool = open_database(&app, input.data_directory).await?;
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
            "knowledge_object" if dependency.knowledge_object_id.is_some() => {}
            "document_block" if dependency.document_id.is_some() => {}
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
    let content: Value = serde_json::from_str(&input.content_json)
        .map_err(|error| format!("View override JSON 无效：{error}"))?;
    let pool = open_database(&app, input.data_directory).await?;
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
