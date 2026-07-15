use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rmcp::{
    model::{CallToolRequestParams, ReadResourceRequestParams},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
        TokioChildProcess,
    },
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::{process::Command, time::timeout};

use crate::agent_cancellation::ToolCancellationGuard;

const CONFIG_FILE: &str = "mcp-servers.json";
const MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigStore {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    servers: Vec<McpServerConfig>,
}

fn store_version() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryInput {
    pub data_directory: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMcpConfigInput {
    pub data_directory: String,
    pub source_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMcpConfigTextInput {
    pub data_directory: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerMutationInput {
    pub data_directory: String,
    pub server_id: String,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerTrustInput {
    pub data_directory: String,
    pub server_id: String,
    pub trusted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMcpToolsInput {
    pub data_directory: String,
    #[serde(default)]
    pub server_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallMcpToolInput {
    pub data_directory: String,
    #[serde(default)]
    pub call_id: Option<String>,
    pub server_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub arguments: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMcpResourceInput {
    pub data_directory: String,
    pub server_id: String,
    pub uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
    pub server_trusted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceDescriptor {
    pub server_id: String,
    pub server_name: String,
    pub uri: String,
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<u64>,
}

#[tauri::command]
pub fn list_mcp_servers(input: DataDirectoryInput) -> Result<Vec<McpServerConfig>, String> {
    Ok(load_store(&input.data_directory)?.servers)
}

#[tauri::command]
pub fn import_mcp_config(input: ImportMcpConfigInput) -> Result<Vec<McpServerConfig>, String> {
    let source = fs::read_to_string(&input.source_path)
        .map_err(|error| format!("无法读取 MCP 配置文件：{error}"))?;
    import_mcp_source(&input.data_directory, &source)
}

#[tauri::command]
pub fn import_mcp_config_text(
    input: ImportMcpConfigTextInput,
) -> Result<Vec<McpServerConfig>, String> {
    import_mcp_source(&input.data_directory, &input.content)
}

fn import_mcp_source(data_directory: &str, source: &str) -> Result<Vec<McpServerConfig>, String> {
    let value: Value =
        serde_json::from_str(source).map_err(|error| format!("MCP 配置不是有效 JSON：{error}"))?;
    let imported = parse_imported_servers(value)?;
    let mut store = load_store(data_directory)?;
    for server in imported {
        if let Some(existing) = store.servers.iter_mut().find(|item| item.id == server.id) {
            *existing = server;
        } else {
            store.servers.push(server);
        }
    }
    store
        .servers
        .sort_by(|left, right| left.name.cmp(&right.name));
    save_store(data_directory, &store)?;
    Ok(store.servers)
}

#[tauri::command]
pub fn set_mcp_server_enabled(input: McpServerMutationInput) -> Result<McpServerConfig, String> {
    let mut store = load_store(&input.data_directory)?;
    let server = store
        .servers
        .iter_mut()
        .find(|server| server.id == input.server_id)
        .ok_or_else(|| "MCP 服务不存在。".to_string())?;
    server.enabled = input.enabled.unwrap_or(false);
    let result = server.clone();
    save_store(&input.data_directory, &store)?;
    Ok(result)
}

#[tauri::command]
pub fn set_mcp_server_trusted(input: McpServerTrustInput) -> Result<McpServerConfig, String> {
    let mut store = load_store(&input.data_directory)?;
    let server = store
        .servers
        .iter_mut()
        .find(|server| server.id == input.server_id)
        .ok_or_else(|| "MCP 服务不存在。".to_string())?;
    server.trusted = input.trusted;
    let result = server.clone();
    save_store(&input.data_directory, &store)?;
    Ok(result)
}

#[tauri::command]
pub fn remove_mcp_server(input: McpServerMutationInput) -> Result<(), String> {
    let mut store = load_store(&input.data_directory)?;
    let old_len = store.servers.len();
    store.servers.retain(|server| server.id != input.server_id);
    if store.servers.len() == old_len {
        return Err("MCP 服务不存在。".to_string());
    }
    save_store(&input.data_directory, &store)
}

#[tauri::command]
pub async fn list_mcp_tools(input: ListMcpToolsInput) -> Result<Vec<McpToolDescriptor>, String> {
    let store = load_store(&input.data_directory)?;
    let servers: Vec<_> = store
        .servers
        .into_iter()
        .filter(|server| {
            input
                .server_id
                .as_ref()
                .map(|id| id == &server.id)
                .unwrap_or(server.enabled)
        })
        .collect();
    let mut descriptors = Vec::new();
    for server in servers {
        let tools = list_server_tools(&server).await?;
        descriptors.extend(tools.into_iter().map(|tool| {
            let read_only = tool
                .annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint)
                .unwrap_or(false);
            McpToolDescriptor {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                name: tool.name.to_string(),
                title: tool.title,
                description: tool
                    .description
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                input_schema: Value::Object((*tool.input_schema).clone()),
                read_only,
                server_trusted: server.trusted,
            }
        }));
    }
    Ok(descriptors)
}

#[tauri::command]
pub async fn call_mcp_tool(input: CallMcpToolInput) -> Result<Value, String> {
    let store = load_store(&input.data_directory)?;
    let server = store
        .servers
        .into_iter()
        .find(|server| server.id == input.server_id && server.enabled)
        .ok_or_else(|| "MCP 服务不存在或未启用。".to_string())?;
    let execution = call_server_tool(&server, &input.tool_name, input.arguments);
    if let Some(call_id) = input.call_id {
        let cancellation = ToolCancellationGuard::register(call_id)?;
        tokio::select! {
            result = execution => result,
            _ = cancellation.cancelled() => Err("Agent MCP 工具调用已取消。".to_string()),
        }
    } else {
        execution.await
    }
}

#[tauri::command]
pub async fn list_mcp_resources(
    input: ListMcpToolsInput,
) -> Result<Vec<McpResourceDescriptor>, String> {
    let store = load_store(&input.data_directory)?;
    let servers: Vec<_> = store
        .servers
        .into_iter()
        .filter(|server| {
            input
                .server_id
                .as_ref()
                .map(|id| id == &server.id)
                .unwrap_or(server.enabled)
        })
        .collect();
    let mut descriptors = Vec::new();
    for server in servers {
        let resources = list_server_resources(&server).await?;
        descriptors.extend(resources.into_iter().map(|resource| McpResourceDescriptor {
            server_id: server.id.clone(),
            server_name: server.name.clone(),
            uri: resource.uri,
            name: resource.name,
            title: resource.title,
            description: resource.description,
            mime_type: resource.mime_type,
            size: resource.size,
        }));
    }
    Ok(descriptors)
}

#[tauri::command]
pub async fn read_mcp_resource(input: ReadMcpResourceInput) -> Result<Value, String> {
    if input.uri.trim().is_empty() {
        return Err("MCP Resource URI 不能为空。".to_string());
    }
    let store = load_store(&input.data_directory)?;
    let server = store
        .servers
        .into_iter()
        .find(|server| server.id == input.server_id && server.enabled)
        .ok_or_else(|| "MCP 服务不存在或未启用。".to_string())?;
    read_server_resource(&server, &input.uri).await
}

async fn list_server_resources(
    server: &McpServerConfig,
) -> Result<Vec<rmcp::model::Resource>, String> {
    match server.transport.as_str() {
        "stdio" => {
            let mut client = timeout(MCP_TIMEOUT, ().serve(stdio_transport(server)?))
                .await
                .map_err(|_| "MCP stdio 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let resources = timeout(MCP_TIMEOUT, client.peer().list_all_resources())
                .await
                .map_err(|_| "MCP Resource 发现超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            Ok(resources)
        }
        "http" => {
            let mut client = timeout(MCP_TIMEOUT, ().serve(http_transport(server)?))
                .await
                .map_err(|_| "MCP HTTP 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let resources = timeout(MCP_TIMEOUT, client.peer().list_all_resources())
                .await
                .map_err(|_| "MCP Resource 发现超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            Ok(resources)
        }
        _ => Err("不支持的 MCP transport。".to_string()),
    }
}

async fn read_server_resource(server: &McpServerConfig, uri: &str) -> Result<Value, String> {
    let params = ReadResourceRequestParams::new(uri.to_string());
    let result = match server.transport.as_str() {
        "stdio" => {
            let mut client = timeout(MCP_TIMEOUT, ().serve(stdio_transport(server)?))
                .await
                .map_err(|_| "MCP stdio 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let result = timeout(MCP_TIMEOUT, client.peer().read_resource(params.clone()))
                .await
                .map_err(|_| "MCP Resource 读取超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            result
        }
        "http" => {
            let mut client = timeout(MCP_TIMEOUT, ().serve(http_transport(server)?))
                .await
                .map_err(|_| "MCP HTTP 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let result = timeout(MCP_TIMEOUT, client.peer().read_resource(params))
                .await
                .map_err(|_| "MCP Resource 读取超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            result
        }
        _ => return Err("不支持的 MCP transport。".to_string()),
    };
    serde_json::to_value(result).map_err(mcp_error)
}

async fn list_server_tools(server: &McpServerConfig) -> Result<Vec<rmcp::model::Tool>, String> {
    match server.transport.as_str() {
        "stdio" => {
            let transport = stdio_transport(server)?;
            let mut client = timeout(MCP_TIMEOUT, ().serve(transport))
                .await
                .map_err(|_| "MCP stdio 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let tools = timeout(MCP_TIMEOUT, client.peer().list_all_tools())
                .await
                .map_err(|_| "MCP 工具发现超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            Ok(tools)
        }
        "http" => {
            let transport = http_transport(server)?;
            let mut client = timeout(MCP_TIMEOUT, ().serve(transport))
                .await
                .map_err(|_| "MCP HTTP 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let tools = timeout(MCP_TIMEOUT, client.peer().list_all_tools())
                .await
                .map_err(|_| "MCP 工具发现超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            Ok(tools)
        }
        _ => Err("不支持的 MCP transport。".to_string()),
    }
}

async fn call_server_tool(
    server: &McpServerConfig,
    tool_name: &str,
    arguments: Map<String, Value>,
) -> Result<Value, String> {
    let params = CallToolRequestParams::new(tool_name.to_string()).with_arguments(arguments);
    match server.transport.as_str() {
        "stdio" => {
            let transport = stdio_transport(server)?;
            let mut client = timeout(MCP_TIMEOUT, ().serve(transport))
                .await
                .map_err(|_| "MCP stdio 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let result = timeout(MCP_TIMEOUT, client.peer().call_tool(params))
                .await
                .map_err(|_| "MCP 工具调用超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            serde_json::to_value(result).map_err(mcp_error)
        }
        "http" => {
            let transport = http_transport(server)?;
            let mut client = timeout(MCP_TIMEOUT, ().serve(transport))
                .await
                .map_err(|_| "MCP HTTP 初始化超时。".to_string())?
                .map_err(mcp_error)?;
            let result = timeout(MCP_TIMEOUT, client.peer().call_tool(params))
                .await
                .map_err(|_| "MCP 工具调用超时。".to_string())?
                .map_err(mcp_error)?;
            let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
            serde_json::to_value(result).map_err(mcp_error)
        }
        _ => Err("不支持的 MCP transport。".to_string()),
    }
}

fn stdio_transport(server: &McpServerConfig) -> Result<TokioChildProcess, String> {
    let executable = server
        .command
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "stdio MCP 服务缺少 command。".to_string())?;
    let mut command = Command::new(executable);
    command.args(&server.args);
    command.envs(&server.env);
    if let Some(cwd) = server
        .cwd
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.current_dir(cwd);
    }
    TokioChildProcess::new(command).map_err(|error| format!("无法启动 MCP 服务：{error}"))
}

fn http_transport(
    server: &McpServerConfig,
) -> Result<StreamableHttpClientTransport<reqwest::Client>, String> {
    let url = server
        .url
        .as_deref()
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .ok_or_else(|| "HTTP MCP 服务必须提供 http:// 或 https:// URL。".to_string())?;
    let mut config = StreamableHttpClientTransportConfig::with_uri(url.to_string());
    for (name, value) in &server.headers {
        let header_name = name
            .parse()
            .map_err(|_| format!("无效的 MCP HTTP header 名称：{name}"))?;
        let header_value = value
            .parse()
            .map_err(|_| format!("无效的 MCP HTTP header 值：{name}"))?;
        config.custom_headers.insert(header_name, header_value);
    }
    Ok(StreamableHttpClientTransport::from_config(config))
}

fn parse_imported_servers(value: Value) -> Result<Vec<McpServerConfig>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "MCP 配置根节点必须是对象。".to_string())?;
    let collection = object
        .get("mcpServers")
        .or_else(|| object.get("servers"))
        .and_then(Value::as_object)
        .unwrap_or(object);
    let mut ids = HashSet::new();
    let mut servers = Vec::new();
    for (key, raw) in collection {
        let raw = raw
            .as_object()
            .ok_or_else(|| format!("MCP 服务 {key} 必须是对象。"))?;
        let id = unique_id(normalize_id(key), &mut ids);
        let command = string_field(raw, "command");
        let url = string_field(raw, "url").or_else(|| string_field(raw, "endpoint"));
        let transport = if command.is_some() {
            "stdio"
        } else if url.is_some() {
            "http"
        } else {
            return Err(format!("MCP 服务 {key} 必须包含 command 或 url。"));
        };
        servers.push(McpServerConfig {
            id,
            name: string_field(raw, "name").unwrap_or_else(|| key.clone()),
            transport: transport.to_string(),
            enabled: raw
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    !raw.get("disabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                }),
            trusted: false,
            command,
            args: string_array(raw.get("args")),
            env: string_map(raw.get("env")),
            cwd: string_field(raw, "cwd"),
            url,
            headers: string_map(raw.get("headers")),
        });
    }
    if servers.is_empty() {
        return Err("配置中没有找到 MCP 服务。".to_string());
    }
    Ok(servers)
}

fn config_path(data_directory: &str) -> Result<PathBuf, String> {
    let directory = Path::new(data_directory);
    if data_directory.trim().is_empty() {
        return Err("数据目录不能为空。".to_string());
    }
    fs::create_dir_all(directory).map_err(mcp_error)?;
    Ok(directory.join(CONFIG_FILE))
}

fn load_store(data_directory: &str) -> Result<McpConfigStore, String> {
    let path = config_path(data_directory)?;
    if !path.exists() {
        return Ok(McpConfigStore {
            version: store_version(),
            servers: Vec::new(),
        });
    }
    let content = fs::read_to_string(path).map_err(mcp_error)?;
    serde_json::from_str(&content).map_err(|error| format!("MCP 配置损坏：{error}"))
}

fn save_store(data_directory: &str, store: &McpConfigStore) -> Result<(), String> {
    let path = config_path(data_directory)?;
    let temporary = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(store).map_err(mcp_error)?;
    fs::write(&temporary, content).map_err(mcp_error)?;
    if path.exists() {
        fs::remove_file(&path).map_err(mcp_error)?;
    }
    fs::rename(temporary, path).map_err(mcp_error)
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_id(value: &str) -> String {
    let normalized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    normalized
        .trim_matches('-')
        .to_string()
        .chars()
        .take(80)
        .collect()
}

fn unique_id(mut id: String, used: &mut HashSet<String>) -> String {
    if id.is_empty() {
        id = "mcp-server".to_string();
    }
    let base = id.clone();
    let mut suffix = 2;
    while !used.insert(id.clone()) {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }
    id
}

fn mcp_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::{
        model::{
            CallToolResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
            ReadResourceResult, ServerCapabilities, ServerInfo,
        },
        service::{RequestContext, RoleServer},
        ServerHandler,
    };

    #[derive(Debug, Clone, Default)]
    struct HttpFixtureServer;

    impl ServerHandler for HttpFixtureServer {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(
                ServerCapabilities::builder()
                    .enable_tools()
                    .enable_resources()
                    .build(),
            )
        }

        async fn list_tools(
            &self,
            _request: Option<PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> Result<ListToolsResult, rmcp::ErrorData> {
            serde_json::from_value(serde_json::json!({
                "tools": [{
                    "name": "echo",
                    "description": "Echo a value.",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "value": { "type": "string" } },
                        "required": ["value"]
                    },
                    "annotations": { "readOnlyHint": true }
                }, {
                    "name": "slow",
                    "description": "Wait until the client cancels.",
                    "inputSchema": { "type": "object" },
                    "annotations": { "readOnlyHint": true }
                }]
            }))
            .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))
        }

        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> Result<CallToolResult, rmcp::ErrorData> {
            if request.name == "slow" {
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
            let value = request
                .arguments
                .as_ref()
                .and_then(|arguments| arguments.get("value"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::from_value(serde_json::json!({
                "content": [{ "type": "text", "text": format!("echo:{value}") }],
                "isError": false
            }))
            .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))
        }

        async fn list_resources(
            &self,
            _request: Option<PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> Result<ListResourcesResult, rmcp::ErrorData> {
            serde_json::from_value(serde_json::json!({
                "resources": [{
                    "uri": "fixture://rules",
                    "name": "rules",
                    "mimeType": "application/json"
                }]
            }))
            .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))
        }

        async fn read_resource(
            &self,
            request: ReadResourceRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> Result<ReadResourceResult, rmcp::ErrorData> {
            serde_json::from_value(serde_json::json!({
                "contents": [{
                    "uri": request.uri,
                    "mimeType": "application/json",
                    "text": "[{\"id\":\"rule-http-1\"}]"
                }]
            }))
            .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))
        }
    }

    async fn spawn_http_fixture() -> (McpServerConfig, tokio::task::JoinHandle<()>) {
        use rmcp::transport::streamable_http_server::{
            session::local::LocalSessionManager, StreamableHttpServerConfig,
            StreamableHttpService,
        };

        let service: StreamableHttpService<HttpFixtureServer, LocalSessionManager> =
            StreamableHttpService::new(
                || Ok(HttpFixtureServer),
                Default::default(),
                StreamableHttpServerConfig::default().with_sse_keep_alive(None),
            );
        let router = axum::Router::new().nest_service("/mcp", service);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (
            McpServerConfig {
                id: "http-fixture".to_string(),
                name: "HTTP Fixture".to_string(),
                transport: "http".to_string(),
                enabled: true,
                trusted: true,
                command: None,
                args: Vec::new(),
                env: HashMap::new(),
                cwd: None,
                url: Some(format!("http://{address}/mcp")),
                headers: HashMap::from([("X-Smoke".to_string(), "g0".to_string())]),
            },
            handle,
        )
    }

    #[test]
    fn parses_common_stdio_and_http_config() {
        let servers = parse_imported_servers(serde_json::json!({
            "mcpServers": {
                "filesystem": { "command": "npx", "args": ["-y", "server"], "disabled": true },
                "remote api": { "url": "https://example.com/mcp", "headers": { "X-Key": "secret" } }
            }
        }))
        .unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].transport, "stdio");
        assert!(!servers[0].enabled);
        assert_eq!(servers[1].id, "remote-api");
        assert_eq!(servers[1].transport, "http");
    }

    #[test]
    fn rejects_entries_without_transport() {
        let error = parse_imported_servers(serde_json::json!({
            "mcpServers": { "broken": { "args": [] } }
        }))
        .unwrap_err();
        assert!(error.contains("command 或 url"));
    }

    #[test]
    fn imports_pasted_config_into_the_store() {
        let directory =
            std::env::temp_dir().join(format!("mynotebook-mcp-text-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);

        let servers = import_mcp_source(
            directory.to_str().unwrap(),
            r#"{"mcpServers":{"local":{"command":"node","args":["server.mjs"]}}}"#,
        )
        .unwrap();

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "local");
        assert_eq!(servers[0].command.as_deref(), Some("node"));
        assert!(directory.join(CONFIG_FILE).exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn completes_stdio_handshake_discovery_and_call() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test-fixtures")
            .join("mcp-stdio-server.mjs");
        let server = McpServerConfig {
            id: "fixture".to_string(),
            name: "Fixture".to_string(),
            transport: "stdio".to_string(),
            enabled: true,
            trusted: true,
            command: Some("node".to_string()),
            args: vec![fixture.to_string_lossy().to_string()],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
        };

        let tools = list_server_tools(&server).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(
            tools[0]
                .annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint),
            Some(true)
        );

        let result = call_server_tool(
            &server,
            "echo",
            Map::from_iter([("value".to_string(), Value::String("hello".to_string()))]),
        )
        .await
        .unwrap();
        assert!(result.to_string().contains("echo:hello"));

        let resources = list_server_resources(&server).await.unwrap();
        assert_eq!(resources[0].uri, "fixture://rules");
        let resource = read_server_resource(&server, "fixture://rules")
            .await
            .unwrap();
        assert!(resource.to_string().contains("rule-1"));
    }

    #[tokio::test]
    async fn completes_streamable_http_handshake_tools_resources_and_cancellation() {
        use crate::agent_cancellation::{
            cancel_agent_tool_call, CancelAgentToolCallInput,
        };

        let (server, handle) = spawn_http_fixture().await;
        let tools = list_server_tools(&server).await.unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "echo");

        let result = call_server_tool(
            &server,
            "echo",
            Map::from_iter([("value".to_string(), Value::String("http".to_string()))]),
        )
        .await
        .unwrap();
        assert!(result.to_string().contains("echo:http"));

        let resources = list_server_resources(&server).await.unwrap();
        assert_eq!(resources[0].uri, "fixture://rules");
        let resource = read_server_resource(&server, "fixture://rules")
            .await
            .unwrap();
        assert!(resource.to_string().contains("rule-http-1"));

        let directory = std::env::temp_dir().join(format!(
            "mynotebook-http-cancel-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        save_store(
            directory.to_str().unwrap(),
            &McpConfigStore {
                version: store_version(),
                servers: vec![server],
            },
        )
        .unwrap();
        let call_id = "http-slow-call".to_string();
        let cancellation_id = call_id.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_agent_tool_call(CancelAgentToolCallInput {
                call_id: cancellation_id,
            })
            .unwrap();
        });
        let error = call_mcp_tool(CallMcpToolInput {
            data_directory: directory.to_string_lossy().to_string(),
            call_id: Some(call_id),
            server_id: "http-fixture".to_string(),
            tool_name: "slow".to_string(),
            arguments: Map::new(),
        })
        .await
        .unwrap_err();
        assert!(error.contains("已取消"));
        cancel_task.await.unwrap();

        handle.abort();
        let _ = fs::remove_dir_all(directory);
    }
}
