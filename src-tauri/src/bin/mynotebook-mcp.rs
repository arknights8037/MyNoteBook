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
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use my_notebook_lib::mcp_server_exposure::{self, McpServerExposureSettings, TOOL_NAMES};

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
    /// Agent project returned by list_agent_projects.
    project_id: Option<String>,
    /// A2A branch returned by create_agent_branch.
    branch_id: Option<String>,
    /// Capability token configured by the local application operator.
    capability_token: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SubmitCognitiveRequest {
    /// Cognitive mode to run: research, review, or learning.
    mode: String,
    /// The question, review focus, or learning topic for the existing in-app Agent Runtime.
    prompt: String,
    /// Agent project returned by list_agent_projects.
    project_id: Option<String>,
    /// A2A branch returned by create_agent_branch.
    branch_id: Option<String>,
    /// Capability token configured by the local application operator.
    capability_token: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListAgentProjectsRequest {
    capability_token: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateAgentBranchRequest {
    project_id: String,
    title: String,
    parent_conversation_id: Option<String>,
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
    /// Human-readable approval reply returned to the knowledge Agent.
    reply: Option<String>,
    /// Optional optimistic guard copied from get_agent_request.result.summary.
    expected_summary: Option<String>,
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
    fn new(
        pool: SqlitePool,
        agent_capability_token: Option<String>,
        exposure: &McpServerExposureSettings,
    ) -> Self {
        let mut tool_router = Self::tool_router();
        for tool_name in TOOL_NAMES {
            if !exposure.is_enabled(tool_name) {
                tool_router.remove_route(tool_name);
            }
        }
        Self {
            pool,
            agent_capability_token,
            tool_router,
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

    /// List Agent projects, workspace root groups, conversations, and A2A branches.
    #[tool(
        name = "list_agent_projects",
        annotations(title = "List Agent projects", read_only_hint = true)
    )]
    async fn list_agent_projects(
        &self,
        Parameters(request): Parameters<ListAgentProjectsRequest>,
    ) -> String {
        if let Err(error) = self.authorize(&request.capability_token) {
            return json!({ "error": error }).to_string();
        }
        match read_agent_projects(&self.pool).await {
            Ok(value) => value.to_string(),
            Err(error) => json!({ "error": error }).to_string(),
        }
    }

    /// Create a stable A2A conversation branch inside an existing Agent project.
    #[tool(name = "create_agent_branch")]
    async fn create_agent_branch(
        &self,
        Parameters(request): Parameters<CreateAgentBranchRequest>,
    ) -> String {
        if let Err(error) = self.authorize(&request.capability_token) {
            return json!({ "error": error }).to_string();
        }
        match create_agent_branch_record(
            &self.pool,
            &request.project_id,
            &request.title,
            request.parent_conversation_id.as_deref(),
        )
        .await
        {
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
        submit_request(
            &self.pool,
            "agent",
            prompt,
            request.project_id.as_deref(),
            request.branch_id.as_deref(),
        )
        .await
        .to_string()
    }

    /// Queue Research, Review, or Learning on the existing in-app Cognitive Runtime.
    #[tool(name = "submit_cognitive_request")]
    async fn submit_cognitive_request(
        &self,
        Parameters(request): Parameters<SubmitCognitiveRequest>,
    ) -> String {
        if let Err(error) = self.authorize(&request.capability_token) {
            return json!({ "error": error }).to_string();
        }
        let mode = match normalize_cognitive_mode(&request.mode) {
            Ok(mode) => mode,
            Err(error) => return json!({ "error": error }).to_string(),
        };
        let prompt = request.prompt.trim();
        if prompt.is_empty() || prompt.chars().count() > 4_000 {
            return json!({ "error": "prompt 必须为 1-4000 个字符。" }).to_string();
        }
        submit_request(
            &self.pool,
            mode,
            prompt,
            request.project_id.as_deref(),
            request.branch_id.as_deref(),
        )
        .await
        .to_string()
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
        let reply = match normalize_decision_reply(&request.action, request.reply.as_deref()) {
            Ok(reply) => reply,
            Err(error) => return json!({ "error": error }).to_string(),
        };
        let now = now_ms();
        let mut transaction = match self.pool.begin().await {
            Ok(transaction) => transaction,
            Err(error) => return json!({ "error": error.to_string() }).to_string(),
        };
        let row = match sqlx::query(
            "SELECT task_id, result_json FROM agent_requests \
             WHERE id = ? AND status = 'awaiting_review' LIMIT 1",
        )
        .bind(&request.request_id)
        .fetch_optional(&mut *transaction)
        .await
        {
            Ok(Some(row)) => row,
            Ok(None) => return json!({ "error": "请求不存在或尚未进入待审阅状态。" }).to_string(),
            Err(error) => return json!({ "error": error.to_string() }).to_string(),
        };
        let task_id = match row.get::<Option<String>, _>("task_id") {
            Some(task_id) => task_id,
            None => return json!({ "error": "待审阅请求缺少 AgentTask。" }).to_string(),
        };
        let result_json = row.get::<Option<String>, _>("result_json");
        let (result_version, result_summary) = result_envelope_identity(result_json.as_deref());
        if let Some(expected) = request.expected_summary.as_deref() {
            if expected.trim() != result_summary {
                return json!({ "error": "result.summary 已变化，请重新读取请求后再审批。" })
                    .to_string();
            }
        }
        let decision = json!({
            "version": 1,
            "action": request.action,
            "reply": reply,
            "requestId": request.request_id,
            "taskId": task_id,
            "resultVersion": result_version,
            "resultSummary": result_summary,
            "decidedAt": now
        });
        let decision_json = decision.to_string();
        let update = sqlx::query(
            "UPDATE agent_requests SET status = ?, decision_json = ?, updated_at = ? \
             WHERE id = ? AND task_id = ? AND status = 'awaiting_review'",
        )
        .bind(next_status)
        .bind(&decision_json)
        .bind(now)
        .bind(&request.request_id)
        .bind(&task_id)
        .execute(&mut *transaction)
        .await;
        match update {
            Ok(result) if result.rows_affected() == 1 => match transaction.commit().await {
                Ok(()) => json!({
                    "requestId": request.request_id,
                    "status": next_status,
                    "decision": decision
                })
                .to_string(),
                Err(error) => json!({ "error": error.to_string() }).to_string(),
            },
            Ok(_) => json!({ "error": "审批时请求状态已变化，请重新读取。" }).to_string(),
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
             error = NULL, decision_json = NULL, completed_at = NULL, updated_at = ? \
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
    let data_directory = parse_data_directory(&database_url)?;
    let exposure = mcp_server_exposure::load(data_directory)?;
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
    NotebookResourceServer::new(pool, agent_capability_token, &exposure)
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

fn create_branch_id(project_id: &str, title: &str, now: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(now.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(project_id.as_bytes());
    hasher.update(title.as_bytes());
    format!("agent-branch-{}", &format!("{:x}", hasher.finalize())[..24])
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

fn parse_data_directory(database_url: &str) -> Result<PathBuf, String> {
    if let Ok(directory) = std::env::var("MYNOTEBOOK_DATA_DIRECTORY") {
        if !directory.trim().is_empty() {
            return Ok(PathBuf::from(directory));
        }
    }
    let database_path = database_url
        .strip_prefix("sqlite://")
        .or_else(|| database_url.strip_prefix("sqlite:"))
        .unwrap_or(database_url)
        .split('?')
        .next()
        .unwrap_or(database_url);
    PathBuf::from(database_path)
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "无法从数据库 URL 推断 MCP Server 设置目录。".to_string())
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

#[derive(Debug)]
struct AgentRoute {
    project_id: Option<String>,
    branch_id: Option<String>,
    branch_title: Option<String>,
    parent_conversation_id: Option<String>,
}

async fn read_agent_projects(pool: &SqlitePool) -> Result<Value, String> {
    let state = read_agent_workspace_state(pool).await?;
    let document_rows =
        sqlx::query("SELECT id, title, document_kind FROM documents WHERE is_deleted = 0")
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?;
    let documents = document_rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("id"),
                (
                    row.get::<String, _>("title"),
                    row.get::<String, _>("document_kind"),
                ),
            )
        })
        .collect::<HashMap<_, _>>();
    let branch_rows = sqlx::query(
        "SELECT id, project_id, parent_conversation_id, title, created_at, updated_at \
         FROM agent_branches ORDER BY updated_at DESC, id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    let branches = branch_rows
        .into_iter()
        .map(|row| {
            json!({
                "branchId": row.get::<String, _>("id"),
                "projectId": row.get::<String, _>("project_id"),
                "parentConversationId": row.get::<Option<String>, _>("parent_conversation_id"),
                "title": row.get::<String, _>("title"),
                "createdAt": row.get::<i64, _>("created_at"),
                "updatedAt": row.get::<i64, _>("updated_at")
            })
        })
        .collect::<Vec<_>>();
    let items = state
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let projects = state
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|project| {
            let project_id = project.get("id")?.as_str()?.to_string();
            let workspace_roots = project
                .get("workspaceRootIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|id| {
                    let metadata = documents.get(id);
                    json!({
                        "documentId": id,
                        "title": metadata.map(|value| value.0.as_str()).unwrap_or(""),
                        "documentKind": metadata.map(|value| value.1.as_str()).unwrap_or("")
                    })
                })
                .collect::<Vec<_>>();
            let conversations = items
                .iter()
                .filter(|item| item.get("projectId").and_then(Value::as_str) == Some(&project_id))
                .map(|item| {
                    json!({
                        "conversationId": item.get("id").and_then(Value::as_str).unwrap_or_default(),
                        "title": item.get("title").and_then(Value::as_str).unwrap_or_default(),
                        "parentConversationId": item.get("parentConversationId").cloned().unwrap_or(Value::Null),
                        "messageCount": item.get("messageCount").and_then(Value::as_i64).unwrap_or(0),
                        "updatedAt": item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)
                    })
                })
                .collect::<Vec<_>>();
            let project_branches = branches
                .iter()
                .filter(|branch| branch.get("projectId").and_then(Value::as_str) == Some(&project_id))
                .cloned()
                .collect::<Vec<_>>();
            Some(json!({
                "projectId": project_id,
                "name": project.get("name").and_then(Value::as_str).unwrap_or("未命名项目"),
                "workspaceRoots": workspace_roots,
                "conversations": conversations,
                "branches": project_branches,
                "updatedAt": project.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "version": 1,
        "activeProjectId": state.get("activeProjectId").cloned().unwrap_or(Value::Null),
        "projects": projects
    }))
}

async fn create_agent_branch_record(
    pool: &SqlitePool,
    project_id: &str,
    title: &str,
    parent_conversation_id: Option<&str>,
) -> Result<Value, String> {
    let project_id = project_id.trim();
    let title = title.trim();
    if project_id.is_empty() || project_id.chars().count() > 200 {
        return Err("project_id 必须为 1-200 个字符。".to_string());
    }
    if title.is_empty() || title.chars().count() > 80 {
        return Err("title 必须为 1-80 个字符。".to_string());
    }
    let state = read_agent_workspace_state(pool).await?;
    if !workspace_project_exists(&state, project_id) {
        return Err("Agent 项目不存在，请先调用 list_agent_projects。".to_string());
    }
    let parent = parent_conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(parent_id) = parent {
        let state_parent_matches = state
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|item| {
                item.get("id").and_then(Value::as_str) == Some(parent_id)
                    && item.get("projectId").and_then(Value::as_str) == Some(project_id)
            });
        let branch_parent_matches =
            sqlx::query("SELECT 1 FROM agent_branches WHERE id = ? AND project_id = ? LIMIT 1")
                .bind(parent_id)
                .bind(project_id)
                .fetch_optional(pool)
                .await
                .map_err(|error| error.to_string())?
                .is_some();
        if !state_parent_matches && !branch_parent_matches {
            return Err("父对话或分支不属于指定项目。".to_string());
        }
    }
    let now = now_ms();
    let branch_id = create_branch_id(project_id, title, now);
    sqlx::query(
        "INSERT INTO agent_branches (id, project_id, parent_conversation_id, title, \
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&branch_id)
    .bind(project_id)
    .bind(parent)
    .bind(title)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|error| error.to_string())?;
    Ok(json!({
        "version": 1,
        "branchId": branch_id,
        "projectId": project_id,
        "parentConversationId": parent,
        "title": title,
        "createdAt": now
    }))
}

async fn resolve_agent_route(
    pool: &SqlitePool,
    project_id: Option<&str>,
    branch_id: Option<&str>,
) -> Result<AgentRoute, String> {
    let requested_project = project_id.map(str::trim).filter(|value| !value.is_empty());
    let requested_branch = branch_id.map(str::trim).filter(|value| !value.is_empty());
    if let Some(branch_id) = requested_branch {
        let row = sqlx::query(
            "SELECT project_id, title, parent_conversation_id FROM agent_branches \
             WHERE id = ? LIMIT 1",
        )
        .bind(branch_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "A2A 分支不存在，请先调用 create_agent_branch。".to_string())?;
        let branch_project = row.get::<String, _>("project_id");
        if requested_project.is_some_and(|project_id| project_id != branch_project) {
            return Err("branch_id 不属于指定 project_id。".to_string());
        }
        return Ok(AgentRoute {
            project_id: Some(branch_project),
            branch_id: Some(branch_id.to_string()),
            branch_title: Some(row.get::<String, _>("title")),
            parent_conversation_id: row.get::<Option<String>, _>("parent_conversation_id"),
        });
    }
    if let Some(project_id) = requested_project {
        let state = read_agent_workspace_state(pool).await?;
        if !workspace_project_exists(&state, project_id) {
            return Err("Agent 项目不存在，请先调用 list_agent_projects。".to_string());
        }
        return Ok(AgentRoute {
            project_id: Some(project_id.to_string()),
            branch_id: None,
            branch_title: None,
            parent_conversation_id: None,
        });
    }
    Ok(AgentRoute {
        project_id: None,
        branch_id: None,
        branch_title: None,
        parent_conversation_id: None,
    })
}

async fn read_agent_workspace_state(pool: &SqlitePool) -> Result<Value, String> {
    let row =
        sqlx::query("SELECT state_json FROM agent_workspace_state WHERE id = 'current' LIMIT 1")
            .fetch_optional(pool)
            .await
            .map_err(|error| error.to_string())?;
    match row {
        Some(row) => serde_json::from_str(&row.get::<String, _>("state_json"))
            .map_err(|error| format!("Agent 项目状态损坏：{error}")),
        None => Ok(json!({ "projects": [], "items": [], "activeProjectId": null })),
    }
}

fn workspace_project_exists(state: &Value, project_id: &str) -> bool {
    state
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
}

async fn read_agent_request(pool: &SqlitePool, id: &str) -> Result<Value, String> {
    let row = sqlx::query(
        "SELECT agent_request.id, agent_request.prompt, agent_request.mode, agent_request.status, \
         agent_request.task_id, agent_request.error, agent_request.result_json, \
         agent_request.decision_json, agent_request.previous_task_id, \
         agent_request.revision_feedback, agent_request.revision_count, \
         agent_request.project_id, agent_request.branch_id, branch.title AS branch_title, \
         branch.parent_conversation_id, agent_request.created_at, \
         agent_request.updated_at, agent_request.completed_at FROM agent_requests agent_request \
         LEFT JOIN agent_branches branch ON branch.id = agent_request.branch_id \
         WHERE agent_request.id = ? LIMIT 1",
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
        "mode": row.get::<String, _>("mode"),
        "status": row.get::<String, _>("status"),
        "taskId": task_id,
        "error": row.get::<Option<String>, _>("error"),
        "result": row.get::<Option<String>, _>("result_json").map(parse_json),
        "decision": row.get::<Option<String>, _>("decision_json").map(parse_json),
        "route": {
            "projectId": row.get::<Option<String>, _>("project_id"),
            "branchId": row.get::<Option<String>, _>("branch_id"),
            "branchTitle": row.get::<Option<String>, _>("branch_title"),
            "parentConversationId": row.get::<Option<String>, _>("parent_conversation_id")
        },
        "previousTaskId": row.get::<Option<String>, _>("previous_task_id"),
        "revisionFeedback": row.get::<Option<String>, _>("revision_feedback"),
        "revisionCount": row.get::<i64, _>("revision_count"),
        "createdAt": row.get::<i64, _>("created_at"),
        "updatedAt": row.get::<i64, _>("updated_at"),
        "completedAt": row.get::<Option<i64>, _>("completed_at"),
        "patches": patches
    }))
}

fn normalize_cognitive_mode(mode: &str) -> Result<&'static str, String> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "research" => Ok("research"),
        "review" => Ok("review"),
        "learning" | "learn" => Ok("learning"),
        _ => Err("mode 必须是 research、review 或 learning。".to_string()),
    }
}

async fn submit_request(
    pool: &SqlitePool,
    mode: &str,
    prompt: &str,
    project_id: Option<&str>,
    branch_id: Option<&str>,
) -> Value {
    let now = now_ms();
    let request_id = create_request_id(&format!("{mode}:{prompt}"), now);
    let route = match resolve_agent_route(pool, project_id, branch_id).await {
        Ok(route) => route,
        Err(error) => return json!({ "error": error }),
    };
    match sqlx::query(
        "INSERT INTO agent_requests (id, prompt, mode, status, project_id, branch_id, \
         created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)",
    )
    .bind(&request_id)
    .bind(prompt)
    .bind(mode)
    .bind(route.project_id.as_deref())
    .bind(route.branch_id.as_deref())
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    {
        Ok(_) => json!({
            "requestId": request_id,
            "mode": mode,
            "status": "queued",
            "route": {
                "projectId": route.project_id,
                "branchId": route.branch_id,
                "branchTitle": route.branch_title,
                "parentConversationId": route.parent_conversation_id
            }
        }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn parse_json(value: String) -> Value {
    serde_json::from_str(&value).unwrap_or(Value::Null)
}

fn normalize_decision_reply(action: &str, reply: Option<&str>) -> Result<String, String> {
    let fallback = if action == "approve" {
        "已审阅知识库 Agent 的 summary 信封并批准当前提案。"
    } else {
        "已审阅知识库 Agent 的 summary 信封并拒绝当前提案。"
    };
    let reply = reply.unwrap_or(fallback).trim();
    if reply.is_empty() || reply.chars().count() > 2_000 {
        return Err("reply 必须为 1-2000 个字符。".to_string());
    }
    Ok(reply.to_string())
}

fn result_envelope_identity(result_json: Option<&str>) -> (Option<i64>, String) {
    let result = result_json
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(Value::Null);
    let version = result.get("version").and_then(Value::as_i64);
    let summary = result
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    (version, summary)
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

#[cfg(test)]
mod tests {
    use super::{
        normalize_cognitive_mode, normalize_decision_reply, result_envelope_identity,
        workspace_project_exists,
    };
    use serde_json::json;

    #[test]
    fn normalizes_supported_cognitive_modes() {
        assert_eq!(normalize_cognitive_mode("research"), Ok("research"));
        assert_eq!(normalize_cognitive_mode("Review"), Ok("review"));
        assert_eq!(normalize_cognitive_mode("learn"), Ok("learning"));
    }

    #[test]
    fn rejects_agent_mode_on_the_cognitive_tool() {
        assert!(normalize_cognitive_mode("agent").is_err());
    }

    #[test]
    fn decision_reply_binds_to_the_result_summary_envelope() {
        let (version, summary) =
            result_envelope_identity(Some(r#"{"version":1,"summary":"已更新两篇知识文档。"}"#));
        assert_eq!(version, Some(1));
        assert_eq!(summary, "已更新两篇知识文档。");
        assert!(normalize_decision_reply("approve", Some("已复核并批准。")).is_ok());
    }

    #[test]
    fn project_route_requires_a_known_workspace_project() {
        let state = json!({ "projects": [{ "id": "project-1" }] });
        assert!(workspace_project_exists(&state, "project-1"));
        assert!(!workspace_project_exists(&state, "project-missing"));
    }
}
