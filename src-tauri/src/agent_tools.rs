use rig_core::{
    completion::ToolDefinition,
    tool::{Tool, ToolSet},
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use std::{fmt, path::PathBuf, time::Duration};
use tauri::AppHandle;

use crate::database::{configured_data_directory, DATABASE_FILENAME};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteRigToolInput {
    data_directory: Option<String>,
    name: String,
    arguments_json: String,
}

#[derive(Debug)]
struct NativeToolError(String);

impl fmt::Display for NativeToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for NativeToolError {}

#[derive(Clone)]
struct SearchDocumentsTool {
    database_path: PathBuf,
}

#[derive(Deserialize)]
struct SearchDocumentsArgs {
    query: String,
    limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocumentResult {
    id: String,
    title: String,
    snippet: String,
    revision: i64,
}

impl Tool for SearchDocumentsTool {
    const NAME: &'static str = "search_documents";
    type Error = NativeToolError;
    type Args = SearchDocumentsArgs;
    type Output = Vec<SearchDocumentResult>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "搜索本地 SQLite FTS5 知识库。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let query = build_fts_query(&args.query);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut connection = open_database(&self.database_path).await?;
        let rows = sqlx::query(
            "SELECT documents.id, documents.title, documents.plain_text, documents.revision \
             FROM document_search INNER JOIN documents ON documents.id = document_search.document_id \
             WHERE document_search MATCH ? AND documents.document_kind = 'article' \
             AND documents.is_deleted = 0 ORDER BY bm25(document_search), documents.updated_at DESC LIMIT ?",
        )
        .bind(query)
        .bind(args.limit.unwrap_or(5).clamp(1, 10))
        .fetch_all(&mut connection)
        .await
        .map_err(native_error)?;
        rows.into_iter()
            .map(|row| {
                let plain_text: String = row.try_get("plain_text").map_err(native_error)?;
                Ok(SearchDocumentResult {
                    id: row.try_get("id").map_err(native_error)?,
                    title: row.try_get("title").map_err(native_error)?,
                    snippet: plain_text.chars().take(500).collect(),
                    revision: row.try_get("revision").map_err(native_error)?,
                })
            })
            .collect()
    }
}

#[derive(Clone)]
struct ReadDocumentTool {
    database_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadDocumentArgs {
    document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadDocumentResult {
    id: String,
    title: String,
    plain_text: String,
    revision: i64,
    tags: Vec<String>,
}

impl Tool for ReadDocumentTool {
    const NAME: &'static str = "read_document";
    type Error = NativeToolError;
    type Args = ReadDocumentArgs;
    type Output = Option<ReadDocumentResult>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "按 ID 读取本地知识库文档。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "documentId": { "type": "string", "minLength": 1 } },
                "required": ["documentId"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut connection = open_database(&self.database_path).await?;
        let row = sqlx::query(
            "SELECT id, title, plain_text, revision FROM documents \
             WHERE id = ? AND document_kind = 'article' AND is_deleted = 0 LIMIT 1",
        )
        .bind(&args.document_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(native_error)?;
        let Some(row) = row else { return Ok(None) };
        let tag_rows = sqlx::query(
            "SELECT tags.name FROM tags INNER JOIN document_tags ON document_tags.tag_id = tags.id \
             WHERE document_tags.document_id = ? ORDER BY tags.name COLLATE NOCASE ASC",
        )
        .bind(&args.document_id)
        .fetch_all(&mut connection)
        .await
        .map_err(native_error)?;
        let text: String = row.try_get("plain_text").map_err(native_error)?;
        Ok(Some(ReadDocumentResult {
            id: row.try_get("id").map_err(native_error)?,
            title: row.try_get("title").map_err(native_error)?,
            plain_text: text.chars().take(12_000).collect(),
            revision: row.try_get("revision").map_err(native_error)?,
            tags: tag_rows
                .into_iter()
                .map(|tag| tag.try_get("name").map_err(native_error))
                .collect::<Result<Vec<_>, _>>()?,
        }))
    }
}

#[tauri::command]
pub(crate) async fn execute_rig_tool(
    app: AppHandle,
    input: ExecuteRigToolInput,
) -> Result<String, String> {
    let database_path = configured_data_directory(&app, input.data_directory)
        .map_err(|error| error.to_string())?
        .join(DATABASE_FILENAME);
    let toolset = ToolSet::builder()
        .static_tool(SearchDocumentsTool {
            database_path: database_path.clone(),
        })
        .static_tool(ReadDocumentTool { database_path })
        .build();
    toolset
        .call(&input.name, input.arguments_json)
        .await
        .map_err(|error| error.to_string())
}

async fn open_database(path: &PathBuf) -> Result<SqliteConnection, NativeToolError> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(native_error)
}

fn build_fts_query(value: &str) -> String {
    value
        .split(|character: char| {
            !character.is_alphanumeric() && character != '_' && character != '-'
        })
        .filter(|term| term.chars().count() >= 2)
        .take(12)
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn native_error(error: impl fmt::Display) -> NativeToolError {
    NativeToolError(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::build_fts_query;

    #[test]
    fn fts_query_is_bounded_and_quoted() {
        assert_eq!(
            build_fts_query("P1 Agent Loop"),
            "\"P1\" OR \"Agent\" OR \"Loop\""
        );
    }
}
