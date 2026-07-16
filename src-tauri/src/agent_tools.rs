use rig_core::{
    completion::ToolDefinition,
    tool::{Tool, ToolSet},
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::{
    collections::{HashMap, HashSet},
    env, fmt, fs,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::{process::Command, time::timeout};

use crate::agent_cancellation::ToolCancellationGuard;
use crate::database::{configured_data_directory, DATABASE_FILENAME};
use crate::document_core::validate_and_project_tiptap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteRigToolInput {
    data_directory: Option<String>,
    call_id: Option<String>,
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
#[serde(rename_all = "camelCase")]
struct SearchDocumentsArgs {
    query: String,
    limit: Option<i64>,
    scope: Option<String>,
    #[serde(default)]
    workspace_root_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocumentResult {
    id: String,
    title: String,
    snippet: String,
    revision: i64,
}

#[derive(Clone)]
struct FindBlocksByRegexTool;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegexBlock {
    id: String,
    #[serde(rename = "type")]
    block_type: String,
    text: String,
    index: usize,
}

#[derive(Deserialize)]
struct FindBlocksByRegexArgs {
    pattern: String,
    #[serde(default)]
    flags: String,
    blocks: Vec<RegexBlock>,
}

#[derive(Clone)]
struct ReplaceBlocksByRegexTool;

#[derive(Deserialize)]
struct ReplaceBlocksByRegexArgs {
    pattern: String,
    replacement: String,
    #[serde(default)]
    flags: String,
    blocks: Vec<RegexBlock>,
}

impl Tool for ReplaceBlocksByRegexTool {
    const NAME: &'static str = "replace_blocks_by_regex";
    type Error = NativeToolError;
    type Args = ReplaceBlocksByRegexArgs;
    type Output = Vec<RegexBlock>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "使用线性时间正则引擎生成块文本替换结果。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "minLength": 1, "maxLength": 240 },
                    "replacement": { "type": "string", "maxLength": 4000 },
                    "flags": { "type": "string" },
                    "blocks": { "type": "array", "maxItems": 10000 }
                },
                "required": ["pattern", "replacement", "blocks"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let expression = build_block_regex(&args.pattern, &args.flags, args.blocks.len())?;
        if args.replacement.chars().count() > 4_000 {
            return Err(NativeToolError(
                "正则替换文本不得超过 4000 个字符。".to_string(),
            ));
        }
        if args.replacement.contains("$`") || args.replacement.contains("$'") {
            return Err(NativeToolError(
                "正则替换不支持 $` 或 $' 上下文引用。".to_string(),
            ));
        }
        let replacement = args.replacement.replace("$&", "$0");
        Ok(args
            .blocks
            .into_iter()
            .filter_map(|mut block| {
                let replaced = if args.flags.contains('g') {
                    expression.replace_all(&block.text, replacement.as_str())
                } else {
                    expression.replace(&block.text, replacement.as_str())
                };
                if replaced == block.text {
                    return None;
                }
                block.text = replaced.into_owned();
                Some(block)
            })
            .collect())
    }
}

impl Tool for FindBlocksByRegexTool {
    const NAME: &'static str = "find_blocks_by_regex";
    type Error = NativeToolError;
    type Args = FindBlocksByRegexArgs;
    type Output = Vec<RegexBlock>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "使用线性时间正则引擎匹配当前文档块。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "minLength": 1, "maxLength": 240 },
                    "flags": { "type": "string" },
                    "blocks": { "type": "array", "maxItems": 10000 }
                },
                "required": ["pattern", "blocks"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let expression = build_block_regex(&args.pattern, &args.flags, args.blocks.len())?;
        Ok(args
            .blocks
            .into_iter()
            .filter(|block| expression.is_match(&block.text))
            .collect())
    }
}

#[derive(Clone)]
struct ListDocumentGroupsTool {
    database_path: PathBuf,
}

#[derive(Deserialize)]
struct ListDocumentGroupsArgs {
    query: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentGroupResult {
    id: String,
    title: String,
    child_count: i64,
}

impl Tool for ListDocumentGroupsTool {
    const NAME: &'static str = "list_document_groups";
    type Error = NativeToolError;
    type Args = ListDocumentGroupsArgs;
    type Output = Vec<DocumentGroupResult>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "列出或按名称筛选知识库分组，返回可用于创建文档的真实父级 ID。"
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "query": { "type": "string" } }
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let query = args.query.unwrap_or_default().trim().to_string();
        let mut connection = open_database(&self.database_path).await?;
        let rows = sqlx::query(
            "SELECT groups.id, groups.title, COUNT(children.id) AS child_count \
             FROM documents groups LEFT JOIN documents children \
               ON children.parent_id = groups.id AND children.is_deleted = 0 \
             WHERE groups.document_kind = 'group' AND groups.is_deleted = 0 \
               AND (? = '' OR instr(lower(groups.title), lower(?)) > 0) \
             GROUP BY groups.id, groups.title \
             ORDER BY groups.sort_order ASC, groups.title COLLATE NOCASE ASC LIMIT 100",
        )
        .bind(&query)
        .bind(&query)
        .fetch_all(&mut connection)
        .await
        .map_err(native_error)?;
        rows.into_iter()
            .map(|row| {
                Ok(DocumentGroupResult {
                    id: row.try_get("id").map_err(native_error)?,
                    title: row.try_get("title").map_err(native_error)?,
                    child_count: row.try_get("child_count").map_err(native_error)?,
                })
            })
            .collect()
    }
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
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10 },
                    "scope": { "type": "string", "enum": ["workspace", "global"] },
                    "workspaceRootIds": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "maxItems": 100
                    }
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
        let scope = args
            .scope
            .as_deref()
            .unwrap_or(if args.workspace_root_ids.is_empty() {
                "global"
            } else {
                "workspace"
            });
        if scope != "workspace" && scope != "global" {
            return Err(NativeToolError(
                "search_documents.scope 必须是 workspace 或 global。".to_string(),
            ));
        }
        if scope == "workspace" && args.workspace_root_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut connection = open_database(&self.database_path).await?;
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT documents.id, documents.title, documents.plain_text, documents.revision \
             FROM document_search INNER JOIN documents ON documents.id = document_search.document_id \
             WHERE document_search MATCH ",
        );
        builder
            .push_bind(query)
            .push(" AND documents.document_kind = 'article' AND documents.is_deleted = 0");
        if scope == "workspace" {
            builder.push(
                " AND documents.id IN (WITH RECURSIVE workspace(id) AS (SELECT id FROM documents WHERE id IN (",
            );
            {
                let mut roots = builder.separated(", ");
                for root_id in &args.workspace_root_ids {
                    roots.push_bind(root_id);
                }
            }
            builder.push(
                ") UNION ALL SELECT child.id FROM documents child JOIN workspace parent ON child.parent_id = parent.id) SELECT id FROM workspace)",
            );
        }
        builder
            .push(" ORDER BY bm25(document_search), documents.updated_at DESC LIMIT ")
            .push_bind(args.limit.unwrap_or(5).clamp(1, 10));
        let rows = builder
            .build()
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
    cursor: Option<usize>,
    max_chars: Option<usize>,
    #[serde(default)]
    block_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadDocumentResult {
    id: String,
    title: String,
    plain_text: String,
    revision: i64,
    tags: Vec<String>,
    blocks: Vec<ReadDocumentBlock>,
    truncated: bool,
    next_cursor: Option<usize>,
    returned_blocks: usize,
    estimated_chars: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadDocumentBlock {
    id: String,
    block_type: String,
    block_index: i64,
    plain_text: String,
    content_json: serde_json::Value,
}

const DEFAULT_SHELL_TIMEOUT_MS: u64 = 10_000;
const MIN_SHELL_TIMEOUT_MS: u64 = 1_000;
const MAX_SHELL_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_SHELL_OUTPUT_LIMIT: usize = 32 * 1024;
const MIN_SHELL_OUTPUT_LIMIT: usize = 4 * 1024;
const MAX_SHELL_OUTPUT_LIMIT: usize = 64 * 1024;
const DEFAULT_DOCUMENT_OUTPUT_LIMIT: usize = 24 * 1024;
const MIN_DOCUMENT_OUTPUT_LIMIT: usize = 4 * 1024;
const MAX_DOCUMENT_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone)]
struct ExecuteShellTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteShellArgs {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteShellResult {
    command: String,
    args: Vec<String>,
    working_directory: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    duration_ms: u128,
    timeout_ms: u64,
    max_output_chars: usize,
}

struct ShellCommandSpec {
    program: String,
    args: Vec<String>,
    environment: HashMap<String, String>,
}

impl Tool for ExecuteShellTool {
    const NAME: &'static str = "execute_shell";
    type Error = NativeToolError;
    type Args = ExecuteShellArgs;
    type Output = ExecuteShellResult;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "执行白名单内的只读 Windows PowerShell 命令或本机工具；不接受脚本字符串。"
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "enum": ["Get-Process", "Get-Service", "Get-Command", "Get-Date", "git", "rg", "where.exe", "node", "pnpm", "npm", "python", "cargo", "rustc"]
                    },
                    "args": {
                        "type": "array",
                        "items": { "type": "string", "maxLength": 500 },
                        "maxItems": 12
                    },
                    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 30000 },
                    "maxOutputChars": { "type": "integer", "minimum": 4096, "maximum": 65536 }
                },
                "required": ["command"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let (timeout_ms, output_limit) =
            resolve_shell_limits(args.timeout_ms, args.max_output_chars)?;
        let spec = build_shell_command(&args.command, &args.args)?;
        let working_directory = std::env::current_dir().map_err(native_error)?;
        let started_at = Instant::now();
        let mut process = Command::new(&spec.program);
        process
            .args(&spec.args)
            .envs(&spec.environment)
            .current_dir(&working_directory)
            .kill_on_drop(true);
        let output = timeout(Duration::from_millis(timeout_ms), process.output())
            .await
            .map_err(|_| NativeToolError(format!("命令执行超过 {timeout_ms} 毫秒，已终止。")))?
            .map_err(|error| NativeToolError(format!("无法启动 {}：{error}", args.command)))?;
        let (stdout, stdout_truncated) = bounded_output(&output.stdout, output_limit);
        let (stderr, stderr_truncated) = bounded_output(&output.stderr, output_limit);
        Ok(ExecuteShellResult {
            command: args.command,
            args: args.args,
            working_directory: working_directory.display().to_string(),
            exit_code: output.status.code(),
            stdout,
            stderr,
            truncated: stdout_truncated || stderr_truncated,
            duration_ms: started_at.elapsed().as_millis(),
            timeout_ms,
            max_output_chars: output_limit,
        })
    }
}

#[derive(Clone)]
struct InspectEnvironmentPathsTool;

#[derive(Deserialize)]
struct EmptyArgs {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentPathEntry {
    path: String,
    exists: bool,
    is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentPathsResult {
    path_entries: Vec<EnvironmentPathEntry>,
    path_extensions: Vec<String>,
    powershell_module_paths: Vec<EnvironmentPathEntry>,
}

impl Tool for InspectEnvironmentPathsTool {
    const NAME: &'static str = "inspect_environment_paths";
    type Error = NativeToolError;
    type Args = EmptyArgs;
    type Output = EnvironmentPathsResult;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "检查当前进程可见的 PATH、PATHEXT 和 PSModulePath；不返回其他环境变量。"
                .to_string(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(EnvironmentPathsResult {
            path_entries: environment_path_entries("PATH", 128),
            path_extensions: env::var("PATHEXT")
                .unwrap_or_default()
                .split(';')
                .filter_map(|value| nonempty(value).map(str::to_string))
                .take(32)
                .collect(),
            powershell_module_paths: environment_path_entries("PSModulePath", 64),
        })
    }
}

#[derive(Clone)]
struct DiscoverLocalToolsTool;

#[derive(Deserialize)]
struct DiscoverLocalToolsArgs {
    #[serde(default)]
    names: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalToolResult {
    name: String,
    found: bool,
    paths: Vec<String>,
}

impl Tool for DiscoverLocalToolsTool {
    const NAME: &'static str = "discover_local_tools";
    type Error = NativeToolError;
    type Args = DiscoverLocalToolsArgs;
    type Output = Vec<LocalToolResult>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "在 PATH 中发现指定或常见本机工具，不执行任何程序。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "names": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1, "maxLength": 80 },
                        "maxItems": 32
                    }
                }
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let names: Vec<String> = if args.names.is_empty() {
            [
                "powershell",
                "pwsh",
                "git",
                "rg",
                "node",
                "pnpm",
                "npm",
                "python",
                "py",
                "cargo",
                "rustc",
                "code",
                "docker",
                "java",
                "go",
                "dotnet",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        } else {
            args.names
        };
        if names.len() > 32 || names.iter().any(|name| !is_safe_tool_name(name)) {
            return Err(NativeToolError(
                "工具名最多 32 个，且只能包含字母、数字、点、下划线、加号和连字符。".to_string(),
            ));
        }
        Ok(discover_local_tools(&names))
    }
}

#[derive(Clone)]
struct GetSystemInfoTool;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfoResult {
    operating_system: &'static str,
    family: &'static str,
    architecture: &'static str,
    logical_cpu_count: usize,
    current_directory: String,
    computer_name: Option<String>,
}

impl Tool for GetSystemInfoTool {
    const NAME: &'static str = "get_system_info";
    type Error = NativeToolError;
    type Args = EmptyArgs;
    type Output = SystemInfoResult;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "读取操作系统、架构、逻辑 CPU 数和当前工作目录。".to_string(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(SystemInfoResult {
            operating_system: env::consts::OS,
            family: env::consts::FAMILY,
            architecture: env::consts::ARCH,
            logical_cpu_count: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
            current_directory: env::current_dir()
                .map_err(native_error)?
                .display()
                .to_string(),
            computer_name: env::var("COMPUTERNAME")
                .ok()
                .filter(|value| !value.is_empty()),
        })
    }
}

impl Tool for ReadDocumentTool {
    const NAME: &'static str = "read_document";
    type Error = NativeToolError;
    type Args = ReadDocumentArgs;
    type Output = Option<ReadDocumentResult>;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "按 ID 分页读取本地知识库文档；支持 cursor、maxChars 和 blockIds。"
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "documentId": { "type": "string", "minLength": 1 },
                    "cursor": { "type": "integer", "minimum": 0 },
                    "maxChars": { "type": "integer", "minimum": 4096, "maximum": 65536 },
                    "blockIds": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "maxItems": 100
                    }
                },
                "required": ["documentId"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut connection = open_database(&self.database_path).await?;
        let row = sqlx::query(
            "SELECT id, title, content_json, revision FROM documents \
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
        let content_json: String = row.try_get("content_json").map_err(native_error)?;
        let projection =
            validate_and_project_tiptap(&content_json, true).map_err(NativeToolError)?;
        if args.block_ids.len() > 100 {
            return Err(NativeToolError("blockIds 最多包含 100 项。".to_string()));
        }
        let max_chars = args.max_chars.unwrap_or(DEFAULT_DOCUMENT_OUTPUT_LIMIT);
        if !(MIN_DOCUMENT_OUTPUT_LIMIT..=MAX_DOCUMENT_OUTPUT_LIMIT).contains(&max_chars) {
            return Err(NativeToolError(format!(
                "maxChars 必须在 {MIN_DOCUMENT_OUTPUT_LIMIT} 到 {MAX_DOCUMENT_OUTPUT_LIMIT} 之间。"
            )));
        }
        let requested_ids: HashSet<&str> = args.block_ids.iter().map(String::as_str).collect();
        let has_explicit_blocks = !requested_ids.is_empty();
        let cursor = if has_explicit_blocks {
            0
        } else {
            args.cursor.unwrap_or(0)
        };
        let total_blocks = projection.blocks.len();
        if cursor > total_blocks {
            return Err(NativeToolError("cursor 超出文档块范围。".to_string()));
        }
        let mut returned_blocks = Vec::new();
        let mut estimated_chars = 0usize;
        for block in projection.blocks.into_iter().skip(cursor) {
            if has_explicit_blocks && !requested_ids.contains(block.id.as_str()) {
                continue;
            }
            let block_chars = block.plain_text.chars().count() + block.content_json.chars().count();
            if estimated_chars.saturating_add(block_chars) > max_chars {
                if returned_blocks.is_empty() {
                    return Err(NativeToolError(
                        "下一个 canonical 块超过 maxChars 预算；请提高预算或用更小的目标块。"
                            .to_string(),
                    ));
                }
                break;
            }
            estimated_chars = estimated_chars.saturating_add(block_chars);
            returned_blocks.push(ReadDocumentBlock {
                id: block.id,
                block_type: block.block_type,
                block_index: block.block_index,
                plain_text: block.plain_text,
                content_json: serde_json::from_str(&block.content_json)
                    .unwrap_or(serde_json::Value::Null),
            });
        }
        if has_explicit_blocks && returned_blocks.len() != requested_ids.len() {
            return Err(NativeToolError(
                "一个或多个 blockIds 不存在，或目标块超过单次 maxChars 预算。".to_string(),
            ));
        }
        let returned_count = returned_blocks.len();
        let next_cursor = if has_explicit_blocks || cursor + returned_count >= total_blocks {
            None
        } else {
            Some(cursor + returned_count)
        };
        Ok(Some(ReadDocumentResult {
            id: row.try_get("id").map_err(native_error)?,
            title: row.try_get("title").map_err(native_error)?,
            plain_text: projection.plain_text.chars().take(2_000).collect(),
            revision: row.try_get("revision").map_err(native_error)?,
            tags: tag_rows
                .into_iter()
                .map(|tag| tag.try_get("name").map_err(native_error))
                .collect::<Result<Vec<_>, _>>()?,
            blocks: returned_blocks,
            truncated: next_cursor.is_some(),
            next_cursor,
            returned_blocks: returned_count,
            estimated_chars,
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
        .static_tool(ListDocumentGroupsTool {
            database_path: database_path.clone(),
        })
        .static_tool(ReadDocumentTool { database_path })
        .static_tool(FindBlocksByRegexTool)
        .static_tool(ReplaceBlocksByRegexTool)
        .static_tool(ExecuteShellTool)
        .static_tool(InspectEnvironmentPathsTool)
        .static_tool(DiscoverLocalToolsTool)
        .static_tool(GetSystemInfoTool)
        .build();
    let execution = toolset.call(&input.name, input.arguments_json);
    if let Some(call_id) = input.call_id {
        let cancellation = ToolCancellationGuard::register(call_id)?;
        tokio::select! {
            result = execution => result.map_err(|error| error.to_string()),
            _ = cancellation.cancelled() => Err("Agent 工具调用已取消。".to_string()),
        }
    } else {
        execution.await.map_err(|error| error.to_string())
    }
}

fn build_block_regex(
    pattern: &str,
    flags: &str,
    block_count: usize,
) -> Result<regex::Regex, NativeToolError> {
    if pattern.is_empty() || pattern.chars().count() > 240 {
        return Err(NativeToolError(
            "正则表达式长度必须在 1 到 240 个字符之间。".to_string(),
        ));
    }
    if block_count > 10_000 {
        return Err(NativeToolError("正则匹配的块数量超过上限。".to_string()));
    }
    if flags.chars().any(|flag| !matches!(flag, 'g' | 'i' | 'm')) {
        return Err(NativeToolError(
            "正则表达式仅支持 g、i、m 标志。".to_string(),
        ));
    }
    regex::RegexBuilder::new(pattern)
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .size_limit(2 * 1024 * 1024)
        .dfa_size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|error| NativeToolError(format!("正则表达式无效或不受支持：{error}")))
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

fn build_shell_command(
    command: &str,
    args: &[String],
) -> Result<ShellCommandSpec, NativeToolError> {
    if args.len() > 12
        || args
            .iter()
            .any(|value| value.len() > 500 || value.contains('\0'))
    {
        return Err(NativeToolError("命令参数超出数量或长度限制。".to_string()));
    }
    match command {
        "Get-Process" => powershell_query(
            args,
            "Get-Process | Select-Object -First 50 Name,Id,CPU,WorkingSet | ConvertTo-Json -Compress",
            "Get-Process -Name $env:MYNOTEBOOK_AGENT_TARGET -ErrorAction Stop | Select-Object -First 50 Name,Id,CPU,WorkingSet | ConvertTo-Json -Compress",
        ),
        "Get-Service" => powershell_query(
            args,
            "Get-Service | Select-Object -First 50 Name,Status,DisplayName | ConvertTo-Json -Compress",
            "Get-Service -Name $env:MYNOTEBOOK_AGENT_TARGET -ErrorAction Stop | Select-Object -First 50 Name,Status,DisplayName | ConvertTo-Json -Compress",
        ),
        "Get-Command" => {
            let target = require_safe_name(args, "Get-Command 需要且只接受一个命令名。")?;
            powershell_spec(
                "Get-Command -Name $env:MYNOTEBOOK_AGENT_TARGET -ErrorAction Stop | Select-Object Name,CommandType,Source,Version | ConvertTo-Json -Compress",
                Some(target),
            )
        }
        "Get-Date" if args.is_empty() => powershell_spec("Get-Date -Format o", None),
        "git" => build_git_command(args),
        "rg" => build_rg_command(args),
        "where.exe" => {
            let target = require_safe_name(args, "where.exe 需要且只接受一个工具名。")?;
            Ok(executable_spec("where.exe", vec![target.to_string()]))
        }
        "node" | "cargo" | "rustc" => build_version_command(command, command, args),
        "pnpm" => build_version_command(command, "pnpm.cmd", args),
        "npm" => build_version_command(command, "npm.cmd", args),
        "python" => build_version_command(command, "python.exe", args),
        _ => Err(NativeToolError(format!("命令 {command} 不在白名单中。"))),
    }
}

fn resolve_shell_limits(
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
) -> Result<(u64, usize), NativeToolError> {
    let timeout_ms = timeout_ms.unwrap_or(DEFAULT_SHELL_TIMEOUT_MS);
    if !(MIN_SHELL_TIMEOUT_MS..=MAX_SHELL_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(NativeToolError(format!(
            "timeoutMs 必须在 {MIN_SHELL_TIMEOUT_MS} 到 {MAX_SHELL_TIMEOUT_MS} 之间。"
        )));
    }
    let output_limit = max_output_chars.unwrap_or(DEFAULT_SHELL_OUTPUT_LIMIT);
    if !(MIN_SHELL_OUTPUT_LIMIT..=MAX_SHELL_OUTPUT_LIMIT).contains(&output_limit) {
        return Err(NativeToolError(format!(
            "maxOutputChars 必须在 {MIN_SHELL_OUTPUT_LIMIT} 到 {MAX_SHELL_OUTPUT_LIMIT} 之间。"
        )));
    }
    Ok((timeout_ms, output_limit))
}

fn powershell_query(
    args: &[String],
    list_script: &str,
    named_script: &str,
) -> Result<ShellCommandSpec, NativeToolError> {
    match args {
        [] => powershell_spec(list_script, None),
        _ => {
            let target = require_safe_name(args, "该 PowerShell 查询最多接受一个名称参数。")?;
            powershell_spec(named_script, Some(target))
        }
    }
}

fn powershell_spec(
    script: &str,
    target: Option<&str>,
) -> Result<ShellCommandSpec, NativeToolError> {
    let mut environment = HashMap::new();
    if let Some(target) = target {
        environment.insert("MYNOTEBOOK_AGENT_TARGET".to_string(), target.to_string());
    }
    Ok(ShellCommandSpec {
        program: "powershell.exe".to_string(),
        args: vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script.to_string(),
        ],
        environment,
    })
}

fn require_safe_name<'a>(args: &'a [String], message: &str) -> Result<&'a str, NativeToolError> {
    if args.len() != 1
        || args[0].is_empty()
        || !args[0]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-*?".contains(character))
    {
        return Err(NativeToolError(message.to_string()));
    }
    Ok(&args[0])
}

fn build_git_command(args: &[String]) -> Result<ShellCommandSpec, NativeToolError> {
    let Some((subcommand, options)) = args.split_first() else {
        return Err(NativeToolError("git 必须指定只读子命令。".to_string()));
    };
    let valid = match subcommand.as_str() {
        "status" => options
            .iter()
            .all(|arg| matches!(arg.as_str(), "--short" | "--branch" | "--porcelain=v1")),
        "diff" => options.iter().all(|arg| {
            matches!(
                arg.as_str(),
                "--cached" | "--stat" | "--name-only" | "--name-status"
            )
        }),
        "log" => validate_git_log_options(options),
        "branch" => options
            .iter()
            .all(|arg| matches!(arg.as_str(), "--show-current" | "--list")),
        "rev-parse" => {
            matches!(options, [value] if matches!(value.as_str(), "--show-toplevel" | "--is-inside-work-tree"))
                || matches!(options, [flag, head] if flag == "--abbrev-ref" && head == "HEAD")
        }
        "ls-files" => options.is_empty(),
        _ => false,
    };
    if !valid {
        return Err(NativeToolError(format!(
            "git 子命令或参数不在只读白名单中：{}",
            args.join(" ")
        )));
    }
    let mut safe_args = args.to_vec();
    if subcommand == "diff" {
        safe_args.insert(1, "--no-ext-diff".to_string());
    }
    if subcommand == "log"
        && !options
            .iter()
            .any(|arg| arg == "-n" || arg.starts_with("-n"))
    {
        safe_args.extend(["-n".to_string(), "50".to_string()]);
    }
    Ok(executable_spec("git.exe", safe_args))
}

fn validate_git_log_options(args: &[String]) -> bool {
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--oneline" | "--decorate" | "--all" => index += 1,
            "-n" if index + 1 < args.len() => {
                let count = args[index + 1].parse::<u16>().ok();
                if !matches!(count, Some(1..=100)) {
                    return false;
                }
                index += 2;
            }
            value if value.starts_with("-n") => {
                let count = value[2..].parse::<u16>().ok();
                if !matches!(count, Some(1..=100)) {
                    return false;
                }
                index += 1;
            }
            _ => return false,
        }
    }
    true
}

fn build_rg_command(args: &[String]) -> Result<ShellCommandSpec, NativeToolError> {
    if !(1..=2).contains(&args.len()) || args[0].is_empty() {
        return Err(NativeToolError(
            "rg 仅接受搜索表达式和可选的相对路径。".to_string(),
        ));
    }
    if let Some(path) = args.get(1) {
        let path = Path::new(path);
        if path.is_absolute()
            || path.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(NativeToolError(
                "rg 只能搜索当前工作目录内的相对路径。".to_string(),
            ));
        }
    }
    let mut safe_args = vec![
        "--no-config".to_string(),
        "--color".to_string(),
        "never".to_string(),
        "--line-number".to_string(),
        "--max-count".to_string(),
        "50".to_string(),
        "--".to_string(),
        args[0].clone(),
    ];
    if let Some(path) = args.get(1) {
        safe_args.push(path.clone());
    }
    Ok(executable_spec("rg.exe", safe_args))
}

fn build_version_command(
    label: &str,
    program: &str,
    args: &[String],
) -> Result<ShellCommandSpec, NativeToolError> {
    if !args.is_empty() && args != ["--version"] {
        return Err(NativeToolError(format!("{label} 仅允许查询 --version。")));
    }
    Ok(executable_spec(program, vec!["--version".to_string()]))
}

fn executable_spec(program: &str, args: Vec<String>) -> ShellCommandSpec {
    ShellCommandSpec {
        program: program.to_string(),
        args,
        environment: HashMap::new(),
    }
}

fn bounded_output(bytes: &[u8], limit: usize) -> (String, bool) {
    let value = String::from_utf8_lossy(bytes);
    let mut characters = value.chars();
    let output: String = characters.by_ref().take(limit).collect();
    (output, characters.next().is_some())
}

fn environment_path_entries(variable: &str, limit: usize) -> Vec<EnvironmentPathEntry> {
    let Some(value) = env::var_os(variable) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    env::split_paths(&value)
        .filter(|path| !path.as_os_str().is_empty())
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .take(limit)
        .map(|path| EnvironmentPathEntry {
            exists: path.exists(),
            is_directory: path.is_dir(),
            path: path.display().to_string(),
        })
        .collect()
}

fn nonempty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn is_safe_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '+')
        })
}

fn discover_local_tools(names: &[String]) -> Vec<LocalToolResult> {
    let path_entries = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let extensions = executable_extensions();
    names
        .iter()
        .map(|name| {
            let candidate_names = if Path::new(name).extension().is_some() {
                vec![name.clone()]
            } else {
                extensions
                    .iter()
                    .map(|extension| format!("{name}{extension}"))
                    .collect()
            };
            let mut found_paths = Vec::new();
            let mut seen = HashSet::new();
            for directory in &path_entries {
                for candidate_name in &candidate_names {
                    let candidate = directory.join(candidate_name);
                    if fs::metadata(&candidate).is_ok_and(|metadata| metadata.is_file()) {
                        let display = candidate.display().to_string();
                        if seen.insert(display.to_lowercase()) {
                            found_paths.push(display);
                        }
                        if found_paths.len() >= 3 {
                            break;
                        }
                    }
                }
                if found_paths.len() >= 3 {
                    break;
                }
            }
            LocalToolResult {
                name: name.clone(),
                found: !found_paths.is_empty(),
                paths: found_paths,
            }
        })
        .collect()
}

fn executable_extensions() -> Vec<String> {
    let mut extensions: Vec<String> = env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter_map(|value| nonempty(value).map(|value| value.to_ascii_lowercase()))
        .collect();
    if !extensions.iter().any(String::is_empty) {
        extensions.push(String::new());
    }
    extensions
}

fn native_error(error: impl fmt::Display) -> NativeToolError {
    NativeToolError(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_fts_query, build_shell_command, discover_local_tools, is_safe_tool_name,
        resolve_shell_limits, FindBlocksByRegexArgs, FindBlocksByRegexTool, RegexBlock,
        ReplaceBlocksByRegexArgs, ReplaceBlocksByRegexTool,
    };
    use rig_core::tool::Tool;

    #[test]
    fn fts_query_is_bounded_and_quoted() {
        assert_eq!(
            build_fts_query("P1 Agent Loop"),
            "\"P1\" OR \"Agent\" OR \"Loop\""
        );
    }

    #[test]
    fn shell_allowlist_accepts_read_only_commands() {
        assert!(build_shell_command("Get-Process", &["code".to_string()]).is_ok());
        assert!(build_shell_command("git", &["status".to_string(), "--short".to_string()]).is_ok());
        assert!(build_shell_command("rg", &["Agent".to_string(), "src".to_string()]).is_ok());
    }

    #[test]
    fn shell_allowlist_rejects_scripts_writes_and_parent_paths() {
        assert!(build_shell_command("powershell", &["Remove-Item".to_string()]).is_err());
        assert!(build_shell_command("git", &["reset".to_string(), "--hard".to_string()]).is_err());
        assert!(build_shell_command("rg", &["secret".to_string(), "..\\".to_string()]).is_err());
        assert!(build_shell_command("Get-Command", &["git; whoami".to_string()]).is_err());
    }

    #[test]
    fn local_tool_discovery_validates_names_and_scans_path() {
        assert!(is_safe_tool_name("git.exe"));
        assert!(!is_safe_tool_name("..\\git.exe"));
        assert!(!is_safe_tool_name("git;whoami"));
        let results = discover_local_tools(&["tool-that-does-not-exist-019f593a".to_string()]);
        assert_eq!(results.len(), 1);
        assert!(!results[0].found);
    }

    #[test]
    fn shell_resource_limits_are_flexible_but_bounded() {
        assert_eq!(resolve_shell_limits(None, None).unwrap(), (10_000, 32_768));
        assert_eq!(
            resolve_shell_limits(Some(2_500), Some(8_192)).unwrap(),
            (2_500, 8_192)
        );
        assert!(resolve_shell_limits(Some(999), None).is_err());
        assert!(resolve_shell_limits(Some(30_001), None).is_err());
        assert!(resolve_shell_limits(None, Some(70_000)).is_err());
    }

    #[tokio::test]
    async fn block_regex_uses_linear_time_engine() {
        let blocks = vec![RegexBlock {
            id: "block-1".to_string(),
            block_type: "paragraph".to_string(),
            text: format!("{}!", "a".repeat(100_000)),
            index: 0,
        }];
        let result = FindBlocksByRegexTool
            .call(FindBlocksByRegexArgs {
                pattern: "^(a+)+$".to_string(),
                flags: String::new(),
                blocks,
            })
            .await
            .unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn block_regex_rejects_unsupported_backreferences() {
        let result = FindBlocksByRegexTool
            .call(FindBlocksByRegexArgs {
                pattern: r"(a)\1".to_string(),
                flags: String::new(),
                blocks: Vec::new(),
            })
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn block_regex_replacement_supports_global_captures() {
        let result = ReplaceBlocksByRegexTool
            .call(ReplaceBlocksByRegexArgs {
                pattern: r"\[([^]]+)\]".to_string(),
                replacement: "<$1>".to_string(),
                flags: "g".to_string(),
                blocks: vec![RegexBlock {
                    id: "block-1".to_string(),
                    block_type: "paragraph".to_string(),
                    text: "[P0] 与 [P1]".to_string(),
                    index: 0,
                }],
            })
            .await
            .unwrap();
        assert_eq!(result[0].text, "<P0> 与 <P1>");
    }
}
