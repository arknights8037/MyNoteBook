use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use tauri::AppHandle;

use crate::database::{database_error, open_database};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCognitiveSessionInput {
    data_directory: Option<String>,
    id: String,
    conversation_id: String,
    mode_id: String,
    mode_version: i64,
    template_id: Option<String>,
    template_version: Option<i64>,
    skill_ids: Vec<String>,
    target_document_ids: Vec<String>,
    target_block_ids: Vec<String>,
    state: Value,
    status: String,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetCognitiveSessionInput {
    data_directory: Option<String>,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListCognitiveSessionsInput {
    data_directory: Option<String>,
    conversation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCognitiveSessionInput {
    data_directory: Option<String>,
    id: String,
    expected_version: i64,
    state: Option<Value>,
    status: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CognitiveSessionRecord {
    id: String,
    conversation_id: String,
    mode_id: String,
    mode_version: i64,
    template_id: Option<String>,
    template_version: Option<i64>,
    skill_ids: Vec<String>,
    target_document_ids: Vec<String>,
    target_block_ids: Vec<String>,
    state: Value,
    status: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
}

#[tauri::command]
pub(crate) async fn create_cognitive_session(
    app: AppHandle,
    input: CreateCognitiveSessionInput,
) -> Result<CognitiveSessionRecord, String> {
    validate_create(&input)?;
    let connection = open_database(&app, input.data_directory).await?;
    sqlx::query(
        "INSERT INTO cognitive_sessions (id, conversation_id, mode_id, mode_version, template_id, template_version, \
         skill_ids_json, target_document_ids_json, target_block_ids_json, state_json, status, version, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&input.id).bind(&input.conversation_id).bind(&input.mode_id).bind(input.mode_version)
    .bind(&input.template_id).bind(input.template_version)
    .bind(serde_json::to_string(&input.skill_ids).map_err(database_error)?)
    .bind(serde_json::to_string(&input.target_document_ids).map_err(database_error)?)
    .bind(serde_json::to_string(&input.target_block_ids).map_err(database_error)?)
    .bind(input.state.to_string()).bind(&input.status).bind(input.created_at).bind(input.created_at)
    .execute(connection.as_ref()).await.map_err(database_error)?;
    get_session(connection.as_ref(), &input.id).await
}

#[tauri::command]
pub(crate) async fn get_cognitive_session(
    app: AppHandle,
    input: GetCognitiveSessionInput,
) -> Result<CognitiveSessionRecord, String> {
    let connection = open_database(&app, input.data_directory).await?;
    get_session(connection.as_ref(), &input.id).await
}

#[tauri::command]
pub(crate) async fn list_cognitive_sessions(
    app: AppHandle,
    input: ListCognitiveSessionsInput,
) -> Result<Vec<CognitiveSessionRecord>, String> {
    let connection = open_database(&app, input.data_directory).await?;
    let rows = sqlx::query("SELECT * FROM cognitive_sessions WHERE conversation_id = ? ORDER BY updated_at DESC, id ASC")
        .bind(&input.conversation_id).fetch_all(connection.as_ref()).await.map_err(database_error)?;
    rows.into_iter().map(map_row).collect()
}

#[tauri::command]
pub(crate) async fn update_cognitive_session(
    app: AppHandle,
    input: UpdateCognitiveSessionInput,
) -> Result<CognitiveSessionRecord, String> {
    let connection = open_database(&app, input.data_directory).await?;
    let current = get_session(connection.as_ref(), &input.id).await?;
    let status = input.status.unwrap_or_else(|| current.status.clone());
    if !is_allowed_transition(&current.status, &status) {
        return Err("Cognitive Session 状态转换无效。".to_string());
    }
    let state = input.state.unwrap_or(current.state);
    let result = sqlx::query("UPDATE cognitive_sessions SET state_json = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
        .bind(state.to_string()).bind(status).bind(input.updated_at).bind(&input.id).bind(input.expected_version)
        .execute(connection.as_ref()).await.map_err(database_error)?;
    if result.rows_affected() != 1 {
        return Err("Cognitive Session 版本已变化。".to_string());
    }
    get_session(connection.as_ref(), &input.id).await
}

async fn get_session(pool: &sqlx::SqlitePool, id: &str) -> Result<CognitiveSessionRecord, String> {
    let row = sqlx::query("SELECT * FROM cognitive_sessions WHERE id = ? LIMIT 1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(database_error)?;
    row.map(map_row)
        .transpose()?
        .ok_or_else(|| "Cognitive Session 不存在。".to_string())
}

fn map_row(row: sqlx::sqlite::SqliteRow) -> Result<CognitiveSessionRecord, String> {
    let json = |key: &str| -> Result<Value, String> {
        serde_json::from_str(&row.try_get::<String, _>(key).map_err(database_error)?)
            .map_err(database_error)
    };
    let strings = |key: &str| -> Result<Vec<String>, String> {
        serde_json::from_str(&row.try_get::<String, _>(key).map_err(database_error)?)
            .map_err(database_error)
    };
    Ok(CognitiveSessionRecord {
        id: row.try_get("id").map_err(database_error)?,
        conversation_id: row.try_get("conversation_id").map_err(database_error)?,
        mode_id: row.try_get("mode_id").map_err(database_error)?,
        mode_version: row.try_get("mode_version").map_err(database_error)?,
        template_id: row.try_get("template_id").map_err(database_error)?,
        template_version: row.try_get("template_version").map_err(database_error)?,
        skill_ids: strings("skill_ids_json")?,
        target_document_ids: strings("target_document_ids_json")?,
        target_block_ids: strings("target_block_ids_json")?,
        state: json("state_json")?,
        status: row.try_get("status").map_err(database_error)?,
        version: row.try_get("version").map_err(database_error)?,
        created_at: row.try_get("created_at").map_err(database_error)?,
        updated_at: row.try_get("updated_at").map_err(database_error)?,
    })
}

fn validate_create(input: &CreateCognitiveSessionInput) -> Result<(), String> {
    if input.id.trim().is_empty()
        || input.conversation_id.trim().is_empty()
        || input.mode_version < 1
        || !matches!(
            input.status.as_str(),
            "active" | "waiting_user" | "completed" | "cancelled"
        )
    {
        return Err("Cognitive Session 创建参数无效。".to_string());
    }
    Ok(())
}
fn is_allowed_transition(from: &str, to: &str) -> bool {
    from == to
        || matches!(
            (from, to),
            ("active", "waiting_user" | "completed" | "cancelled")
                | ("waiting_user", "active" | "completed" | "cancelled")
        )
}
