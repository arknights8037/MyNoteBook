use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::AppHandle;

use crate::database::{database_error, open_database};
use crate::document_core::{replace_block_projection, validate_and_project_tiptap};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatchDraft {
    id: String,
    operation: String,
    document_id: String,
    block_id: String,
    target_block_ids_json: String,
    expected_version: i64,
    before_text: String,
    after_text: String,
    reason: String,
    document_title: Option<String>,
    parent_document_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceDraft {
    document_id: String,
    document_title: String,
    block_ids_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentPatchSetInput {
    data_directory: Option<String>,
    task_id: String,
    model: String,
    created_at: i64,
    patches: Vec<AgentPatchDraft>,
    sources: Vec<AgentSourceDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatchDecision {
    id: String,
    after_text: String,
    accepted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAgentPatchSetInput {
    data_directory: Option<String>,
    task_id: String,
    document_id: String,
    expected_revision: i64,
    content_json: String,
    transaction_id: String,
    patches: Vec<AgentPatchDecision>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAgentDocumentCreationInput {
    data_directory: Option<String>,
    task_id: String,
    patch_id: String,
    document_id: String,
    parent_document_id: Option<String>,
    title: String,
    content_json: String,
    transaction_id: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectAgentPatchSetInput {
    data_directory: Option<String>,
    task_id: String,
    patch_ids: Vec<String>,
    completed_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackAgentTransactionInput {
    data_directory: Option<String>,
    transaction_id: String,
    rolled_back_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentContextBundleInput {
    data_directory: Option<String>,
    id: String,
    task_id: String,
    version: i64,
    scope_json: String,
    permission_snapshot_json: String,
    sources_json: String,
    active_rules_json: String,
    decisions_json: String,
    conflicts_json: String,
    compiler_json: String,
    snapshot_hash: String,
    correlation_id: String,
    causation_id: Option<String>,
    execution_policy_json: String,
    provider: String,
    model_parameters_json: String,
    ignored_parameters_json: String,
    skill_versions_json: String,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTransactionResult {
    id: String,
    task_id: String,
    document_id: String,
    before_revision: i64,
    resulting_revision: i64,
    created_at: i64,
}

#[tauri::command]
pub async fn save_agent_context_bundle(
    app: AppHandle,
    input: SaveAgentContextBundleInput,
) -> Result<(), String> {
    for (name, value) in [
        ("scope", &input.scope_json),
        ("permissionSnapshot", &input.permission_snapshot_json),
        ("sources", &input.sources_json),
        ("compiler", &input.compiler_json),
        ("executionPolicy", &input.execution_policy_json),
        ("modelParameters", &input.model_parameters_json),
        ("ignoredParameters", &input.ignored_parameters_json),
        ("skillVersions", &input.skill_versions_json),
    ] {
        serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("{name} JSON 无效：{error}"))?;
    }
    if input.snapshot_hash.len() != 64
        || !input
            .snapshot_hash
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("Context Bundle snapshot hash 无效。".to_string());
    }
    let pool = open_database(&app, input.data_directory).await?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let task_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_tasks WHERE id = ?")
        .bind(&input.task_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
    if task_exists != 1 {
        return Err("Context Bundle 对应的 Agent 任务不存在。".to_string());
    }
    sqlx::query(
        "INSERT INTO context_bundles (id, task_id, version, scope_json, permission_snapshot_json, \
         sources_json, active_rules_json, decisions_json, conflicts_json, compiler_json, \
         snapshot_hash, correlation_id, causation_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(task_id, snapshot_hash) DO NOTHING",
    )
    .bind(&input.id)
    .bind(&input.task_id)
    .bind(input.version)
    .bind(&input.scope_json)
    .bind(&input.permission_snapshot_json)
    .bind(&input.sources_json)
    .bind(&input.active_rules_json)
    .bind(&input.decisions_json)
    .bind(&input.conflicts_json)
    .bind(&input.compiler_json)
    .bind(&input.snapshot_hash)
    .bind(&input.correlation_id)
    .bind(&input.causation_id)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    let persisted_bundle_id: String = sqlx::query_scalar(
        "SELECT id FROM context_bundles WHERE task_id = ? AND snapshot_hash = ? LIMIT 1",
    )
    .bind(&input.task_id)
    .bind(&input.snapshot_hash)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    let result = sqlx::query(
        "UPDATE agent_tasks SET context_bundle_id = ?, correlation_id = ?, causation_id = ?, \
         execution_policy_json = ?, provider = ?, model_parameters_json = ?, \
         ignored_parameters_json = ?, skill_versions_json = ? WHERE id = ?",
    )
    .bind(&persisted_bundle_id)
    .bind(&input.correlation_id)
    .bind(&input.causation_id)
    .bind(&input.execution_policy_json)
    .bind(&input.provider)
    .bind(&input.model_parameters_json)
    .bind(&input.ignored_parameters_json)
    .bind(&input.skill_versions_json)
    .bind(&input.task_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err("无法关联 Context Bundle 与 Agent 任务。".to_string());
    }
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
pub async fn save_agent_patch_set(
    app: AppHandle,
    input: SaveAgentPatchSetInput,
) -> Result<(), String> {
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    sqlx::query(
        "INSERT INTO agent_patch_sets (task_id, model, created_at) VALUES (?, ?, ?) \
         ON CONFLICT(task_id) DO UPDATE SET model = excluded.model, created_at = excluded.created_at",
    )
    .bind(&input.task_id)
    .bind(&input.model)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("DELETE FROM agent_patches WHERE task_id = ?")
        .bind(&input.task_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("DELETE FROM agent_task_sources WHERE task_id = ?")
        .bind(&input.task_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    for patch in input.patches {
        sqlx::query(
            "INSERT INTO agent_patches (id, task_id, operation, document_id, block_id, \
             target_block_ids_json, expected_version, before_text, after_text, reason, status, \
             created_at, updated_at, document_title, parent_document_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)",
        )
        .bind(patch.id)
        .bind(&input.task_id)
        .bind(patch.operation)
        .bind(patch.document_id)
        .bind(patch.block_id)
        .bind(patch.target_block_ids_json)
        .bind(patch.expected_version)
        .bind(patch.before_text)
        .bind(patch.after_text)
        .bind(patch.reason)
        .bind(input.created_at)
        .bind(input.created_at)
        .bind(patch.document_title)
        .bind(patch.parent_document_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    for source in input.sources {
        sqlx::query(
            "INSERT INTO agent_task_sources (task_id, document_id, document_title, block_ids_json, created_at) \
             VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, document_id) DO UPDATE SET \
             document_title = excluded.document_title, block_ids_json = excluded.block_ids_json, \
             created_at = excluded.created_at",
        )
        .bind(&input.task_id)
        .bind(source.document_id)
        .bind(source.document_title)
        .bind(source.block_ids_json)
        .bind(input.created_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
pub async fn apply_agent_document_creation(
    app: AppHandle,
    input: ApplyAgentDocumentCreationInput,
) -> Result<AgentTransactionResult, String> {
    let projection = validate_and_project_tiptap(&input.content_json, true)?;
    if input.title.trim().is_empty() || projection.plain_text.trim().is_empty() {
        return Err("新文档标题和内容不能为空。".to_string());
    }
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let task = sqlx::query("SELECT document_id, status FROM agent_tasks WHERE id = ? LIMIT 1")
        .bind(&input.task_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| "找不到 Agent 任务。".to_string())?;
    let task_status: String = task.try_get("status").map_err(database_error)?;
    let task_document_id: String = task.try_get("document_id").map_err(database_error)?;
    if task_status != "waiting_confirmation" {
        return Err("Agent 任务不在等待确认状态。".to_string());
    }
    if input
        .parent_document_id
        .as_deref()
        .is_some_and(|parent| parent != task_document_id)
    {
        return Err("新文档父级超出当前 Agent 任务范围。".to_string());
    }
    let patch = sqlx::query(
        "SELECT operation, status, after_text FROM agent_patches \
         WHERE id = ? AND task_id = ? LIMIT 1",
    )
    .bind(&input.patch_id)
    .bind(&input.task_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| "找不到新文档提案。".to_string())?;
    let operation: String = patch.try_get("operation").map_err(database_error)?;
    let status: String = patch.try_get("status").map_err(database_error)?;
    let proposed_after: String = patch.try_get("after_text").map_err(database_error)?;
    if operation != "create_document" || status != "proposed" {
        return Err("新文档提案状态无效。".to_string());
    }
    validate_patch_after(&projection, &proposed_after, &input.patch_id)?;
    sqlx::query(
        "INSERT INTO documents (id, parent_id, document_kind, title, content_json, plain_text, \
         schema_version, revision, sort_order, is_deleted, created_at, updated_at) \
         VALUES (?, ?, 'article', ?, ?, ?, 2, 1, 0, 0, ?, ?)",
    )
    .bind(&input.document_id)
    .bind(&input.parent_document_id)
    .bind(input.title.trim())
    .bind(&projection.content_json)
    .bind(&projection.plain_text)
    .bind(input.created_at)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    replace_block_projection(
        &mut transaction,
        &input.document_id,
        1,
        input.created_at,
        "article",
        false,
        &projection,
    )
    .await?;
    sqlx::query("UPDATE agent_patches SET status = 'accepted', updated_at = ? WHERE id = ?")
        .bind(input.created_at)
        .bind(&input.patch_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO agent_document_creation_transactions \
         (id, task_id, document_id, status, created_at, rolled_back_at) \
         VALUES (?, ?, ?, 'applied', ?, NULL)",
    )
    .bind(&input.transaction_id)
    .bind(&input.task_id)
    .bind(&input.document_id)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO agent_confirmations (task_id, patch_id, action, details_json, created_at) \
         VALUES (?, ?, 'accepted', ?, ?)",
    )
    .bind(&input.task_id)
    .bind(&input.patch_id)
    .bind(serde_json::json!({ "transactionId": &input.transaction_id }).to_string())
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "UPDATE agent_tasks SET status = 'completed', current_step = '新文档已创建', \
         error = NULL, completed_at = ? WHERE id = ?",
    )
    .bind(input.created_at)
    .bind(&input.task_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(AgentTransactionResult {
        id: input.transaction_id,
        task_id: input.task_id,
        document_id: input.document_id,
        before_revision: 0,
        resulting_revision: 1,
        created_at: input.created_at,
    })
}

#[tauri::command]
pub async fn apply_agent_patch_set(
    app: AppHandle,
    input: ApplyAgentPatchSetInput,
) -> Result<AgentTransactionResult, String> {
    if input.patches.is_empty() || !input.patches.iter().any(|patch| patch.accepted) {
        return Err("至少需要接受一个 Patch。".to_string());
    }
    let projection = validate_and_project_tiptap(&input.content_json, true)?;
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let task = sqlx::query("SELECT document_id, status FROM agent_tasks WHERE id = ? LIMIT 1")
        .bind(&input.task_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| "找不到 Agent 任务。".to_string())?;
    let task_document_id: String = task.try_get("document_id").map_err(database_error)?;
    let task_status: String = task.try_get("status").map_err(database_error)?;
    if task_document_id != input.document_id || task_status != "waiting_confirmation" {
        return Err("Agent 任务与目标文档或确认状态不匹配。".to_string());
    }
    let row = sqlx::query(
        "SELECT revision, content_json, plain_text FROM documents \
         WHERE id = ? AND is_deleted = 0 LIMIT 1",
    )
    .bind(&input.document_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| "目标文档不存在。".to_string())?;
    let revision: i64 = row.try_get("revision").map_err(database_error)?;
    if revision != input.expected_revision {
        return Err("文档版本已变化，需要重新生成 Agent 修改。".to_string());
    }
    let before_content_json: String = row.try_get("content_json").map_err(database_error)?;
    let before_plain_text: String = row.try_get("plain_text").map_err(database_error)?;
    let before_projection = validate_and_project_tiptap(&before_content_json, true)?;
    let mut decision_ids = std::collections::HashSet::new();
    for patch in &input.patches {
        if !decision_ids.insert(patch.id.as_str()) {
            return Err("Patch 决策包含重复 ID。".to_string());
        }
        let stored = sqlx::query(
            "SELECT document_id, target_block_ids_json, expected_version, before_text, status \
             FROM agent_patches WHERE id = ? AND task_id = ? LIMIT 1",
        )
        .bind(&patch.id)
        .bind(&input.task_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or_else(|| format!("Patch {} 不属于当前任务。", patch.id))?;
        let patch_document_id: String = stored.try_get("document_id").map_err(database_error)?;
        let expected_version: i64 = stored.try_get("expected_version").map_err(database_error)?;
        let patch_status: String = stored.try_get("status").map_err(database_error)?;
        if patch_document_id != input.document_id
            || expected_version != input.expected_revision
            || patch_status != "proposed"
        {
            return Err(format!("Patch {} 的文档、版本或状态无效。", patch.id));
        }
        let target_json: String = stored
            .try_get("target_block_ids_json")
            .map_err(database_error)?;
        let target_ids: Vec<String> = serde_json::from_str(&target_json)
            .map_err(|_| format!("Patch {} 的目标块列表损坏。", patch.id))?;
        let stored_before: String = stored.try_get("before_text").map_err(database_error)?;
        validate_patch_before(&before_projection, &target_ids, &stored_before, &patch.id)?;
        if patch.accepted {
            validate_patch_after(&projection, &patch.after_text, &patch.id)?;
        }
    }
    let stored_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_patches WHERE task_id = ? AND status = 'proposed'",
    )
    .bind(&input.task_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if stored_count != input.patches.len() as i64 {
        return Err("Patch 决策必须覆盖当前提案的全部 Patch。".to_string());
    }
    for patch in input.patches {
        let status = if patch.accepted {
            "accepted"
        } else {
            "rejected"
        };
        sqlx::query(
            "UPDATE agent_patches SET after_text = ?, status = ?, updated_at = ? \
             WHERE id = ? AND task_id = ?",
        )
        .bind(patch.after_text)
        .bind(status)
        .bind(input.created_at)
        .bind(&patch.id)
        .bind(&input.task_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "INSERT INTO agent_confirmations (task_id, patch_id, action, details_json, created_at) \
             VALUES (?, ?, ?, '{}', ?)",
        )
        .bind(&input.task_id)
        .bind(patch.id)
        .bind(status)
        .bind(input.created_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    let result = sqlx::query(
        "UPDATE documents SET content_json = ?, plain_text = ?, revision = revision + 1, updated_at = ? \
         WHERE id = ? AND revision = ? AND is_deleted = 0",
    )
    .bind(&projection.content_json)
    .bind(&projection.plain_text)
    .bind(input.created_at)
    .bind(&input.document_id)
    .bind(input.expected_revision)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err("文档在写入时发生变化。".to_string());
    }
    let resulting_revision = input.expected_revision + 1;
    replace_block_projection(
        &mut transaction,
        &input.document_id,
        resulting_revision,
        input.created_at,
        "article",
        false,
        &projection,
    )
    .await?;
    sqlx::query(
        "INSERT INTO agent_document_transactions (id, task_id, document_id, before_revision, \
         resulting_revision, before_content_json, before_plain_text, after_content_json, \
         after_plain_text, status, created_at, rolled_back_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, NULL)",
    )
    .bind(&input.transaction_id)
    .bind(&input.task_id)
    .bind(&input.document_id)
    .bind(input.expected_revision)
    .bind(resulting_revision)
    .bind(before_content_json)
    .bind(before_plain_text)
    .bind(&projection.content_json)
    .bind(&projection.plain_text)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "UPDATE agent_tasks SET status = 'completed', current_step = '修改已写入文档', \
         error = NULL, completed_at = ? WHERE id = ?",
    )
    .bind(input.created_at)
    .bind(&input.task_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO agent_confirmations (task_id, patch_id, action, details_json, created_at) \
         VALUES (?, NULL, 'applied', ?, ?)",
    )
    .bind(&input.task_id)
    .bind(serde_json::json!({ "transactionId": &input.transaction_id }).to_string())
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(AgentTransactionResult {
        id: input.transaction_id,
        task_id: input.task_id,
        document_id: input.document_id,
        before_revision: input.expected_revision,
        resulting_revision,
        created_at: input.created_at,
    })
}

#[tauri::command]
pub async fn reject_agent_patch_set(
    app: AppHandle,
    input: RejectAgentPatchSetInput,
) -> Result<(), String> {
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    for patch_id in input.patch_ids {
        sqlx::query("UPDATE agent_patches SET status = 'rejected', updated_at = ? WHERE id = ? AND task_id = ?")
            .bind(input.completed_at).bind(&patch_id).bind(&input.task_id)
            .execute(&mut *transaction).await.map_err(database_error)?;
        sqlx::query("INSERT INTO agent_confirmations (task_id, patch_id, action, details_json, created_at) VALUES (?, ?, 'rejected', '{}', ?)")
            .bind(&input.task_id).bind(patch_id).bind(input.completed_at)
            .execute(&mut *transaction).await.map_err(database_error)?;
    }
    sqlx::query(
        "INSERT INTO agent_confirmations (task_id, patch_id, action, details_json, created_at) \
         VALUES (?, NULL, 'rejected_set', '{}', ?)",
    )
    .bind(&input.task_id)
    .bind(input.completed_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("UPDATE agent_tasks SET status = 'completed', current_step = '用户已拒绝全部修改', error = NULL, completed_at = ? WHERE id = ?")
        .bind(input.completed_at).bind(input.task_id)
        .execute(&mut *transaction).await.map_err(database_error)?;
    transaction.commit().await.map_err(database_error)
}

#[tauri::command]
pub async fn rollback_agent_transaction(
    app: AppHandle,
    input: RollbackAgentTransactionInput,
) -> Result<AgentTransactionResult, String> {
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let row = sqlx::query("SELECT * FROM agent_document_transactions WHERE id = ? LIMIT 1")
        .bind(&input.transaction_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?;
    let Some(row) = row else {
        let creation =
            sqlx::query("SELECT * FROM agent_document_creation_transactions WHERE id = ? LIMIT 1")
                .bind(&input.transaction_id)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(database_error)?
                .ok_or_else(|| "找不到 Agent 写入事务。".to_string())?;
        let status: String = creation.try_get("status").map_err(database_error)?;
        if status != "applied" {
            return Err("该 Agent 修改已经撤销。".to_string());
        }
        let task_id: String = creation.try_get("task_id").map_err(database_error)?;
        let document_id: String = creation.try_get("document_id").map_err(database_error)?;
        let created_at: i64 = creation.try_get("created_at").map_err(database_error)?;
        let result =
            sqlx::query("DELETE FROM documents WHERE id = ? AND revision = 1 AND is_deleted = 0")
                .bind(&document_id)
                .execute(&mut *transaction)
                .await
                .map_err(database_error)?;
        if result.rows_affected() != 1 {
            return Err("新文档创建后已被修改，不能安全撤销。".to_string());
        }
        sqlx::query(
            "UPDATE agent_document_creation_transactions SET status = 'rolled_back', \
             rolled_back_at = ? WHERE id = ?",
        )
        .bind(input.rolled_back_at)
        .bind(&input.transaction_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "INSERT INTO agent_confirmations \
             (task_id, patch_id, action, details_json, created_at) \
             VALUES (?, NULL, 'rolled_back', ?, ?)",
        )
        .bind(&task_id)
        .bind(serde_json::json!({ "transactionId": &input.transaction_id }).to_string())
        .bind(input.rolled_back_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        transaction.commit().await.map_err(database_error)?;
        return Ok(AgentTransactionResult {
            id: input.transaction_id,
            task_id,
            document_id,
            before_revision: 0,
            resulting_revision: 1,
            created_at,
        });
    };
    let status: String = row.try_get("status").map_err(database_error)?;
    if status != "applied" {
        return Err("该 Agent 修改已经撤销。".to_string());
    }
    let task_id: String = row.try_get("task_id").map_err(database_error)?;
    let document_id: String = row.try_get("document_id").map_err(database_error)?;
    let before_revision: i64 = row.try_get("before_revision").map_err(database_error)?;
    let resulting_revision: i64 = row.try_get("resulting_revision").map_err(database_error)?;
    let created_at: i64 = row.try_get("created_at").map_err(database_error)?;
    let before_content_json: String = row.try_get("before_content_json").map_err(database_error)?;
    let projection = validate_and_project_tiptap(&before_content_json, true)?;
    let result = sqlx::query("UPDATE documents SET content_json = ?, plain_text = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND is_deleted = 0")
        .bind(&projection.content_json).bind(&projection.plain_text).bind(input.rolled_back_at)
        .bind(&document_id).bind(resulting_revision)
        .execute(&mut *transaction).await.map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err("文档在 Agent 修改后已发生新的保存，不能安全撤销。".to_string());
    }
    replace_block_projection(
        &mut transaction,
        &document_id,
        resulting_revision + 1,
        input.rolled_back_at,
        "article",
        false,
        &projection,
    )
    .await?;
    sqlx::query("UPDATE agent_document_transactions SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?")
        .bind(input.rolled_back_at).bind(&input.transaction_id)
        .execute(&mut *transaction).await.map_err(database_error)?;
    sqlx::query("INSERT INTO agent_confirmations (task_id, patch_id, action, details_json, created_at) VALUES (?, NULL, 'rolled_back', ?, ?)")
        .bind(&task_id).bind(serde_json::json!({ "transactionId": &input.transaction_id }).to_string())
        .bind(input.rolled_back_at).execute(&mut *transaction).await.map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(AgentTransactionResult {
        id: input.transaction_id,
        task_id,
        document_id,
        before_revision,
        resulting_revision,
        created_at,
    })
}

fn normalize_patch_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

fn validate_patch_before(
    projection: &crate::document_core::ProjectedDocument,
    target_ids: &[String],
    stored_before: &str,
    patch_id: &str,
) -> Result<(), String> {
    if target_ids.is_empty() {
        return Err(format!("Patch {patch_id} 没有目标块。"));
    }
    let current_before = target_ids
        .iter()
        .map(|id| {
            projection
                .blocks
                .iter()
                .find(|block| &block.id == id)
                .map(|block| block.plain_text.as_str())
                .ok_or_else(|| format!("Patch {patch_id} 的目标块 {id} 已不存在。"))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("\n\n");
    if normalize_patch_text(&current_before) != normalize_patch_text(stored_before) {
        return Err(format!("Patch {patch_id} 的目标内容已变化。"));
    }
    Ok(())
}

fn validate_patch_after(
    projection: &crate::document_core::ProjectedDocument,
    accepted_after: &str,
    patch_id: &str,
) -> Result<(), String> {
    let expected = normalize_visible_markdown(accepted_after);
    let actual = normalize_visible_markdown(&projection.plain_text);
    if expected.is_empty() || !actual.contains(&expected) {
        return Err(format!("Patch {patch_id} 的接受内容与结果文档投影不一致。"));
    }
    Ok(())
}

fn normalize_visible_markdown(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut visible = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '[' {
            if let Some(label_end) = chars[index + 1..].iter().position(|value| *value == ']') {
                let label_end = index + 1 + label_end;
                if chars.get(label_end + 1) == Some(&'(') {
                    if let Some(url_end) = chars[label_end + 2..]
                        .iter()
                        .position(|value| *value == ')')
                    {
                        visible.extend(chars[index + 1..label_end].iter());
                        index = label_end + 2 + url_end + 1;
                        continue;
                    }
                }
            }
        }
        let character = chars[index];
        if matches!(
            character,
            '#' | '*' | '_' | '~' | '`' | '>' | '|' | '[' | ']'
        ) {
            visible.push(' ');
        } else {
            visible.push(character);
        }
        index += 1;
    }
    visible
        .split_whitespace()
        .filter(|value| !matches!(*value, "-" | "+" | "x" | "X"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_before_validation_uses_canonical_block_projection() {
        let projection = validate_and_project_tiptap(
            r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"a"},"content":[{"type":"text","text":"第一段"}]},{"type":"paragraph","attrs":{"id":"b"},"content":[{"type":"text","text":"第二段"}]}]}"#,
            true,
        )
        .unwrap();
        validate_patch_before(
            &projection,
            &["a".to_string(), "b".to_string()],
            "第一段\n\n第二段",
            "patch-1",
        )
        .unwrap();
        assert!(
            validate_patch_before(&projection, &["a".to_string()], "已经变化", "patch-1")
                .unwrap_err()
                .contains("内容已变化")
        );
        assert!(
            validate_patch_before(&projection, &["missing".to_string()], "", "patch-1")
                .unwrap_err()
                .contains("已不存在")
        );
        validate_patch_after(&projection, "**第一段**", "patch-1").unwrap();
        assert!(validate_patch_after(&projection, "无关内容", "patch-1")
            .unwrap_err()
            .contains("不一致"));
    }
}
