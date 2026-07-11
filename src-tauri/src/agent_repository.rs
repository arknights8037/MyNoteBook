use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::AppHandle;

use crate::database::{database_error, open_database};

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
    plain_text: String,
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
    plain_text: String,
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
    if input.title.trim().is_empty() || input.plain_text.trim().is_empty() {
        return Err("新文档标题和内容不能为空。".to_string());
    }
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let patch = sqlx::query(
        "SELECT operation, status FROM agent_patches WHERE id = ? AND task_id = ? LIMIT 1",
    )
    .bind(&input.patch_id)
    .bind(&input.task_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or_else(|| "找不到新文档提案。".to_string())?;
    let operation: String = patch.try_get("operation").map_err(database_error)?;
    let status: String = patch.try_get("status").map_err(database_error)?;
    if operation != "create_document" || status != "proposed" {
        return Err("新文档提案状态无效。".to_string());
    }
    sqlx::query(
        "INSERT INTO documents (id, parent_id, document_kind, title, content_json, plain_text, \
         schema_version, revision, sort_order, is_deleted, created_at, updated_at) \
         VALUES (?, ?, 'article', ?, ?, ?, 2, 1, 0, 0, ?, ?)",
    )
    .bind(&input.document_id)
    .bind(&input.parent_document_id)
    .bind(input.title.trim())
    .bind(&input.content_json)
    .bind(&input.plain_text)
    .bind(input.created_at)
    .bind(input.created_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
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
    let connection = open_database(&app, input.data_directory).await?;
    let mut transaction = connection.begin().await.map_err(database_error)?;
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
    .bind(&input.content_json)
    .bind(&input.plain_text)
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
    .bind(&input.content_json)
    .bind(&input.plain_text)
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
    let before_plain_text: String = row.try_get("before_plain_text").map_err(database_error)?;
    let result = sqlx::query("UPDATE documents SET content_json = ?, plain_text = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND is_deleted = 0")
        .bind(before_content_json).bind(before_plain_text).bind(input.rolled_back_at)
        .bind(&document_id).bind(resulting_revision)
        .execute(&mut *transaction).await.map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err("文档在 Agent 修改后已发生新的保存，不能安全撤销。".to_string());
    }
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
