use std::{collections::HashMap, fs, path::Path};

use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "mcp-server-exposure.json";
pub const TOOL_NAMES: [&str; 8] = [
    "search_knowledge",
    "list_agent_projects",
    "create_agent_branch",
    "submit_agent_request",
    "submit_cognitive_request",
    "get_agent_request",
    "decide_agent_request",
    "revise_agent_request",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerExposureSettings {
    #[serde(default = "store_version")]
    pub version: u32,
    #[serde(default = "default_tools")]
    pub tools: HashMap<String, bool>,
}

impl Default for McpServerExposureSettings {
    fn default() -> Self {
        Self {
            version: store_version(),
            tools: default_tools(),
        }
    }
}

impl McpServerExposureSettings {
    pub fn is_enabled(&self, tool_name: &str) -> bool {
        self.tools.get(tool_name).copied().unwrap_or(true)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMcpServerExposureInput {
    pub data_directory: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMcpServerToolExposureInput {
    pub data_directory: String,
    pub tool_name: String,
    pub enabled: bool,
}

fn store_version() -> u32 {
    1
}

fn default_tools() -> HashMap<String, bool> {
    TOOL_NAMES
        .into_iter()
        .map(|name| (name.to_string(), true))
        .collect()
}

pub fn load(data_directory: impl AsRef<Path>) -> Result<McpServerExposureSettings, String> {
    let path = data_directory.as_ref().join(CONFIG_FILE);
    if !path.exists() {
        return Ok(McpServerExposureSettings::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    let mut settings: McpServerExposureSettings = serde_json::from_str(&content)
        .map_err(|error| format!("无法解析 {}：{error}", path.display()))?;
    for name in TOOL_NAMES {
        settings.tools.entry(name.to_string()).or_insert(true);
    }
    Ok(settings)
}

fn save(
    data_directory: impl AsRef<Path>,
    settings: &McpServerExposureSettings,
) -> Result<(), String> {
    let directory = data_directory.as_ref();
    fs::create_dir_all(directory)
        .map_err(|error| format!("无法创建资料目录 {}：{error}", directory.display()))?;
    let path = directory.join(CONFIG_FILE);
    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("无法序列化 MCP Server 设置：{error}"))?;
    fs::write(&path, content).map_err(|error| format!("无法保存 {}：{error}", path.display()))
}

#[tauri::command]
pub fn get_mcp_server_exposure(
    input: GetMcpServerExposureInput,
) -> Result<McpServerExposureSettings, String> {
    load(input.data_directory)
}

#[tauri::command]
pub fn set_mcp_server_tool_exposure(
    input: SetMcpServerToolExposureInput,
) -> Result<McpServerExposureSettings, String> {
    if !TOOL_NAMES.contains(&input.tool_name.as_str()) {
        return Err(format!("未知的 MCP Server 工具：{}", input.tool_name));
    }
    let mut settings = load(&input.data_directory)?;
    settings.tools.insert(input.tool_name, input.enabled);
    save(input.data_directory, &settings)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_preserve_existing_tool_exposure() {
        let directory =
            std::env::temp_dir().join(format!("mynotebook-mcp-exposure-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let settings = load(&directory).expect("default settings");
        assert!(TOOL_NAMES.iter().all(|name| settings.is_enabled(name)));
    }

    #[test]
    fn saved_settings_round_trip_disabled_tools() {
        let directory = std::env::temp_dir().join(format!(
            "mynotebook-mcp-exposure-round-trip-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut settings = McpServerExposureSettings::default();
        settings.tools.insert("decide_agent_request".into(), false);
        save(&directory, &settings).expect("save settings");
        assert!(!load(&directory)
            .expect("load settings")
            .is_enabled("decide_agent_request"));
        let _ = fs::remove_dir_all(directory);
    }
}
