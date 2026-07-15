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
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct NotebookResourceServer {
    pool: SqlitePool,
    agent_capability_token: Option<String>,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SearchKnowledgeRequest {
    /// Plain text to search in canonical document projections.
    query: String,
    /// Maximum results (1-50).
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SubmitAgentRequest {
    /// A task-completion summary and instruction. Do not name target documents or blocks.
    prompt: String,
    /// Capability token configured by the local application operator.
    capability_token: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct GetAgentRequest {
    request_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DecideAgentRequest {
    request_id: String,
    action: String,
    capability_token: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ReviseAgentRequest {
    request_id: String,
    feedback: String,
    capability_token: String,
}

#[tool_router]
impl NotebookResourceServer {
    fn new(pool: SqlitePool, agent_capability_token: Option<String>) -> Self {
        Self {
            pool,
            agent_capability_token,
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

    /// Queue a task for the existing in-app Agent Runtime. This does not approve or apply patches.
    #[tool(name = "submit_agent_request")]
    async fn submit_agent_request(
        &self,
        Parameters(request): Parameters<SubmitAgentRequest>,
    ) -> String {
        if let Err(error) = self.authorize(&request.capability_token) {
            return json!({ "error": error }).to_string();
        }
        let prompt = request.prompt.trim();
        if prompt.is_empty() || prompt.chars().count() > 4_000 {
            return json!({ "error": "prompt 必须为 1-4000 个字符。" }).to_string();
        }
        let now = now_ms();
        let request_id = create_request_id(prompt, now);
        match sqlx::query(
            "INSERT INTO agent_requests (id, prompt, status, created_at, updated_at) \
             VALUES (?, ?, 'queued', ?, ?)",
        )
        .bind(&request_id)
        .bind(prompt)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        {
            Ok(_) => json!({ "requestId": request_id, "status": "queued" }).to_string(),
            Err(error) => json!({ "error": error.to_string() }).to_string(),
        }
    }

    /// Read the request, its Agent task, and any proposed patches.
    #[tool(
        name = "get_agent_request",
        annotations(title = "Get Agent request", read_only_hint = true)
    )]
    async fn get_agent_request(&self, Parameters(request): Parameters<GetAgentRequest>) -> String {
        match read_agent_request(&self.pool, &request.request_id).await {
            Ok(value) => value.to_string(),
            Err(error) => json!({ "error": error }).to_string(),
        }
    }

    /// Approve or reject a queued Agent patch after inspecting get_agent_request.
    #[tool(name = "decide_agent_request")]
    async fn decide_agent_request(
        &self,
        Parameters(request): Parameters<DecideAgentRequest>,
    ) -> String {
        if let Err(error) = self.authorize(&request.capability_token) {
            return json!({ "error": error }).to_string();
        }
        let next_status = match request.action.as_str() {
            "approve" => "approved",
            "reject" => "rejected",
            _ => return json!({ "error": "action 必须是 approve 或 reject。" }).to_string(),
        };
        let now = now_ms();
        match sqlx::query(
            "UPDATE agent_requests SET status = ?, updated_at = ? \
             WHERE id = ? AND status = 'awaiting_review'",
        )
        .bind(next_status)
        .bind(now)
        .bind(&request.request_id)
        .execute(&self.pool)
        .await
        {
            Ok(result) if result.rows_affected() == 1 => {
                json!({ "requestId": request.request_id, "status": next_status }).to_string()
            }
            Ok(_) => json!({ "error": "请求不存在或尚未进入待审阅状态。" }).to_string(),
            Err(error) => json!({ "error": error.to_string() }).to_string(),
        }
    }

    /// Request a revision of the current proposal without starting discovery from scratch.
    #[tool(name = "revise_agent_request")]
    async fn revise_agent_request(
        &self,
        Parameters(request): Parameters<ReviseAgentRequest>,
    ) -> String {
        if let Err(error) = self.authorize(&request.capability_token) {
            return json!({ "error": error }).to_string();
        }
        let feedback = request.feedback.trim();
        if feedback.is_empty() || feedback.chars().count() > 2_000 {
            return json!({ "error": "feedback 必须为 1-2000 个字符。" }).to_string();
        }
        let now = now_ms();
        match sqlx::query(
            "UPDATE agent_requests SET status = 'queued', previous_task_id = task_id, \
             task_id = NULL, revision_feedback = ?, revision_count = revision_count + 1, \
             error = NULL, completed_at = NULL, updated_at = ? \
             WHERE id = ? AND status = 'awaiting_review' AND task_id IS NOT NULL",
        )
        .bind(feedback)
        .bind(now)
        .bind(&request.request_id)
        .execute(&self.pool)
        .await
        {
            Ok(result) if result.rows_affected() == 1 => json!({
                "requestId": request.request_id,
                "status": "queued",
                "revisionRequested": true
            })
            .to_string(),
            Ok(_) => json!({ "error": "请求不存在或当前没有可修订的待审阅提案。" }).to_string(),
            Err(error) => json!({ "error": error.to_string() }).to_string(),
        }
    }
}

impl NotebookResourceServer {
    fn authorize(&self, provided: &str) -> Result<(), String> {
        let expected = self
            .agent_capability_token
            .as_deref()
            .ok_or_else(|| "服务未启用 Agent 写入通信能力。".to_string())?;
        let expected_hash = Sha256::digest(expected.as_bytes());
        let provided_hash = Sha256::digest(provided.as_bytes());
        if expected_hash != provided_hash {
            return Err("Agent capability token 无效。".to_string());
        }
        Ok(())
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
    let agent_capability_token = std::env::var("MYNOTEBOOK_AGENT_CAPABILITY_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if agent_capability_token.is_none() {
        sqlx::query("PRAGMA query_only = ON").execute(&pool).await?;
    }
    NotebookResourceServer::new(pool, agent_capability_token)
        .serve(stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn create_request_id(prompt: &str, now: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(now.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(prompt.as_bytes());
    format!(
        "agent-request-{}",
        &format!("{:x}", hasher.finalize())[..24]
    )
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

async fn read_agent_request(pool: &SqlitePool, id: &str) -> Result<Value, String> {
    let row = sqlx::query(
        "SELECT id, prompt, status, task_id, error, result_json, previous_task_id, \
         revision_feedback, revision_count, created_at, updated_at, completed_at \
         FROM agent_requests WHERE id = ? LIMIT 1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Agent request 不存在。".to_string())?;
    let task_id = row.get::<Option<String>, _>("task_id");
    let patches = if let Some(task_id) = task_id.as_deref() {
        sqlx::query(
            "SELECT id, operation, document_id, block_id, target_block_ids_json, \
             expected_version, before_text, after_text, reason, status \
             FROM agent_patches WHERE task_id = ? ORDER BY created_at ASC",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|patch| {
            json!({
                "id": patch.get::<String, _>("id"),
                "operation": patch.get::<String, _>("operation"),
                "documentId": patch.get::<String, _>("document_id"),
                "blockId": patch.get::<String, _>("block_id"),
                "targetBlockIds": parse_json(patch.get::<String, _>("target_block_ids_json")),
                "expectedVersion": patch.get::<i64, _>("expected_version"),
                "before": patch.get::<String, _>("before_text"),
                "after": patch.get::<String, _>("after_text"),
                "reason": patch.get::<String, _>("reason"),
                "status": patch.get::<String, _>("status")
            })
        })
        .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    Ok(json!({
        "requestId": row.get::<String, _>("id"),
        "prompt": row.get::<String, _>("prompt"),
        "status": row.get::<String, _>("status"),
        "taskId": task_id,
        "error": row.get::<Option<String>, _>("error"),
        "result": row.get::<Option<String>, _>("result_json").map(parse_json),
        "previousTaskId": row.get::<Option<String>, _>("previous_task_id"),
        "revisionFeedback": row.get::<Option<String>, _>("revision_feedback"),
        "revisionCount": row.get::<i64, _>("revision_count"),
        "createdAt": row.get::<i64, _>("created_at"),
        "updatedAt": row.get::<i64, _>("updated_at"),
        "completedAt": row.get::<Option<i64>, _>("completed_at"),
        "patches": patches
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
