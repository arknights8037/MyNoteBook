use rmcp::schemars;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        ErrorData, ListResourcesResult, PaginatedRequestParams, ReadResourceRequestParams,
        ReadResourceResult, Resource, ResourceContents, ServerCapabilities, ServerInfo,
    },
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::stdio,
    RoleServer, ServerHandler, ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

#[derive(Clone)]
struct NotebookResourceServer {
    pool: SqlitePool,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SearchKnowledgeRequest {
    /// Plain text to search in canonical document projections.
    query: String,
    /// Maximum results (1-50).
    limit: Option<i64>,
}

#[tool_router]
impl NotebookResourceServer {
    fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            tool_router: Self::tool_router(),
        }
    }

    /// Search local knowledge documents without modifying any state.
    #[tool(
        name = "search_knowledge",
        annotations(title = "Search knowledge", read_only_hint = true)
    )]
    async fn search_knowledge(
        &self,
        Parameters(request): Parameters<SearchKnowledgeRequest>,
    ) -> String {
        match search_documents(&self.pool, &request.query, request.limit.unwrap_or(20)).await {
            Ok(value) => value.to_string(),
            Err(error) => json!({ "error": error }).to_string(),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for NotebookResourceServer {
    #[allow(deprecated)]
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_resources()
                .enable_tools()
                .build(),
        )
        .with_instructions("只读访问 MyNotebook 当前有效知识、任务和版本化 Context Bundle。")
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new("mynotebook://knowledge/rules", "active-rules")
                .with_title("当前有效规则")
                .with_mime_type("application/json"),
            Resource::new("mynotebook://knowledge/decisions", "active-decisions")
                .with_title("当前有效决策")
                .with_mime_type("application/json"),
            Resource::new("mynotebook://tasks/open", "open-task-runs")
                .with_title("待处理 TaskRun")
                .with_mime_type("application/json"),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        let value = match request.uri.as_str() {
            "mynotebook://knowledge/rules" => read_knowledge(&self.pool, "rule").await,
            "mynotebook://knowledge/decisions" => read_knowledge(&self.pool, "decision").await,
            "mynotebook://tasks/open" => read_open_tasks(&self.pool).await,
            uri if uri.starts_with("mynotebook://context/") => {
                read_context(&self.pool, uri.trim_start_matches("mynotebook://context/")).await
            }
            _ => return Err(ErrorData::resource_not_found("Resource 不存在。", None)),
        }
        .map_err(|error| ErrorData::internal_error(error, None))?;
        Ok(ReadResourceResult::new(vec![ResourceContents::text(
            value.to_string(),
            request.uri,
        )
        .with_mime_type("application/json")]))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = parse_database_url()?;
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;
    sqlx::query("PRAGMA query_only = ON").execute(&pool).await?;
    NotebookResourceServer::new(pool)
        .serve(stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

fn parse_database_url() -> Result<String, String> {
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--database-url" {
            return arguments
                .next()
                .ok_or_else(|| "--database-url 缺少值。".to_string());
        }
    }
    std::env::var("MYNOTEBOOK_DATABASE_URL")
        .map_err(|_| "请传入 --database-url 或 MYNOTEBOOK_DATABASE_URL。".to_string())
}

async fn read_knowledge(pool: &SqlitePool, object_type: &str) -> Result<Value, String> {
    let rows = sqlx::query(
        "SELECT id, title, status, document_id, block_id, source_revision, authority_level, \
         confidence, version, updated_at FROM knowledge_objects WHERE object_type = ? AND \
         status IN ('approved', 'active') AND (valid_from IS NULL OR valid_from <= unixepoch() * 1000) \
         AND (valid_until IS NULL OR valid_until > unixepoch() * 1000) ORDER BY authority_level, title",
    )
    .bind(object_type)
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    Ok(Value::Array(rows.into_iter().map(|row| json!({
        "id": row.get::<String, _>("id"), "title": row.get::<String, _>("title"),
        "status": row.get::<String, _>("status"), "documentId": row.get::<Option<String>, _>("document_id"),
        "blockId": row.get::<Option<String>, _>("block_id"), "sourceRevision": row.get::<Option<i64>, _>("source_revision"),
        "authorityLevel": row.get::<String, _>("authority_level"), "confidence": row.get::<Option<f64>, _>("confidence"),
        "version": row.get::<i64, _>("version"), "updatedAt": row.get::<i64, _>("updated_at")
    })).collect()))
}

async fn read_open_tasks(pool: &SqlitePool) -> Result<Value, String> {
    let rows = sqlx::query(
        "SELECT id, task_definition_id, status, frozen_input_json, acceptance_criteria_json, \
         context_bundle_id, correlation_id, queued_at FROM task_runs WHERE status NOT IN \
         ('completed', 'failed', 'cancelled', 'timed_out') ORDER BY queued_at ASC LIMIT 200",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    Ok(Value::Array(rows.into_iter().map(|row| json!({
        "id": row.get::<String, _>("id"), "taskDefinitionId": row.get::<Option<String>, _>("task_definition_id"),
        "status": row.get::<String, _>("status"),
        "frozenInput": parse_json(row.get::<String, _>("frozen_input_json")),
        "acceptanceCriteria": parse_json(row.get::<String, _>("acceptance_criteria_json")),
        "contextBundleId": row.get::<Option<String>, _>("context_bundle_id"),
        "correlationId": row.get::<String, _>("correlation_id"), "queuedAt": row.get::<i64, _>("queued_at")
    })).collect()))
}

async fn read_context(pool: &SqlitePool, id: &str) -> Result<Value, String> {
    let row = sqlx::query("SELECT * FROM context_bundles WHERE id = ? LIMIT 1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Context Bundle 不存在。".to_string())?;
    Ok(json!({
        "id": row.get::<String, _>("id"), "version": row.get::<i64, _>("version"),
        "scope": parse_json(row.get::<String, _>("scope_json")),
        "permissionSnapshot": parse_json(row.get::<String, _>("permission_snapshot_json")),
        "sources": parse_json(row.get::<String, _>("sources_json")),
        "activeRules": parse_json(row.get::<String, _>("active_rules_json")),
        "decisions": parse_json(row.get::<String, _>("decisions_json")),
        "conflicts": parse_json(row.get::<String, _>("conflicts_json")),
        "compiler": parse_json(row.get::<String, _>("compiler_json")),
        "snapshotHash": row.get::<String, _>("snapshot_hash"),
        "correlationId": row.get::<String, _>("correlation_id")
    }))
}

fn parse_json(value: String) -> Value {
    serde_json::from_str(&value).unwrap_or(Value::Null)
}

async fn search_documents(pool: &SqlitePool, query: &str, limit: i64) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err("query 必须为 1-200 个字符。".to_string());
    }
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let rows = sqlx::query(
        "SELECT id, title, revision, substr(plain_text, 1, 1000) AS snippet \
         FROM documents WHERE is_deleted = 0 AND (title LIKE ? ESCAPE '\\' OR plain_text LIKE ? ESCAPE '\\') \
         ORDER BY updated_at DESC LIMIT ?",
    )
    .bind(&pattern).bind(&pattern).bind(limit.clamp(1, 50))
    .fetch_all(pool).await.map_err(|error| error.to_string())?;
    Ok(Value::Array(rows.into_iter().map(|row| json!({
        "documentId": row.get::<String, _>("id"), "title": row.get::<String, _>("title"),
        "revision": row.get::<i64, _>("revision"), "snippet": row.get::<String, _>("snippet")
    })).collect()))
}
