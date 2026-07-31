use rmcp::schemars;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
    transport::stdio,
    ServerHandler, ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

const DEFAULT_TASK_TIMEOUT_SECONDS: u64 = 900;
const MAX_TASK_TIMEOUT_SECONDS: u64 = 3600;
const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 32_768;
const MAX_OUTPUT_TOKENS: u32 = 65_536;
const MAX_PROMPT_BYTES: usize = 100_000;
const MAX_CAPTURE_BYTES: usize = 1_048_576;

#[derive(Clone)]
struct QoderBridgeServer {
    config: BridgeConfig,
    tool_router: ToolRouter<Self>,
}

#[derive(Clone)]
struct BridgeConfig {
    qoder_executable: PathBuf,
    default_workspace: PathBuf,
    allowed_roots: Vec<PathBuf>,
    git_bash: Option<PathBuf>,
    task_timeout: Duration,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum DelegationMode {
    /// Explore and report without changing files.
    ReadOnly,
    /// Allow Qoder auto mode to edit files inside the selected workspace.
    WorkspaceWrite,
}

impl DelegationMode {
    fn qoder_permission_mode(self) -> &'static str {
        match self {
            Self::ReadOnly => "dont_ask",
            Self::WorkspaceWrite => "auto",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::WorkspaceWrite => "workspace_write",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DelegateTaskRequest {
    /// Natural-language task for Qoder.
    prompt: String,
    /// Existing project directory. It must be inside a root allowed when the bridge starts.
    workspace: Option<String>,
    /// read_only explores without edits; workspace_write allows safe in-workspace edits.
    mode: Option<DelegationMode>,
    /// Maximum model output tokens (512-65536).
    max_output_tokens: Option<u32>,
}

impl BridgeConfig {
    fn from_environment() -> Result<Self, String> {
        let default_workspace = env::var_os("QODER_BRIDGE_WORKSPACE")
            .map(PathBuf::from)
            .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
        let default_workspace = canonical_directory(&default_workspace, "默认工作区")?;

        let mut allowed_roots = vec![default_workspace.clone()];
        if let Ok(source) = env::var("QODER_BRIDGE_ALLOWED_ROOTS_JSON") {
            let paths: Vec<String> = serde_json::from_str(&source)
                .map_err(|error| format!("QODER_BRIDGE_ALLOWED_ROOTS_JSON 无效：{error}"))?;
            for path in paths {
                let root = canonical_directory(Path::new(&path), "允许的工作区根目录")?;
                if !allowed_roots.contains(&root) {
                    allowed_roots.push(root);
                }
            }
        }

        let task_timeout_seconds = env::var("QODER_BRIDGE_TASK_TIMEOUT_SECONDS")
            .ok()
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| "QODER_BRIDGE_TASK_TIMEOUT_SECONDS 必须是整数。".to_string())
            })
            .transpose()?
            .unwrap_or(DEFAULT_TASK_TIMEOUT_SECONDS)
            .clamp(1, MAX_TASK_TIMEOUT_SECONDS);

        Ok(Self {
            qoder_executable: discover_qoder_executable(),
            default_workspace,
            allowed_roots,
            git_bash: discover_git_bash(),
            task_timeout: Duration::from_secs(task_timeout_seconds),
        })
    }

    fn resolve_workspace(&self, requested: Option<&str>) -> Result<PathBuf, String> {
        let workspace = requested
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_workspace.clone());
        let workspace = canonical_directory(&workspace, "工作区")?;
        if !self
            .allowed_roots
            .iter()
            .any(|root| path_is_within(&workspace, root))
        {
            return Err(format!(
                "工作区不在桥接器允许的根目录内：{}",
                workspace.display()
            ));
        }
        Ok(workspace)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.qoder_executable);
        if let Some(git_bash) = &self.git_bash {
            command.env("QODERCN_GIT_BASH_PATH", git_bash);
        }
        command.env("NO_COLOR", "1");
        command
    }
}

#[tool_router]
impl QoderBridgeServer {
    fn new(config: BridgeConfig) -> Self {
        Self {
            config,
            tool_router: Self::tool_router(),
        }
    }

    /// Check the local Qoder executable, bridge policy, and detected Git Bash.
    #[tool(
        name = "qoder_status",
        annotations(title = "Qoder bridge status", read_only_hint = true)
    )]
    async fn qoder_status(&self) -> String {
        let mut command = self.config.command();
        command
            .arg("--version")
            .current_dir(&self.config.default_workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let result = timeout(Duration::from_secs(15), command.output()).await;
        match result {
            Ok(Ok(output)) => json!({
                "ok": output.status.success(),
                "version": String::from_utf8_lossy(&output.stdout).trim(),
                "error": String::from_utf8_lossy(&output.stderr).trim(),
                "executable": self.config.qoder_executable,
                "defaultWorkspace": self.config.default_workspace,
                "allowedRoots": self.config.allowed_roots,
                "gitBash": self.config.git_bash,
                "taskTimeoutSeconds": self.config.task_timeout.as_secs(),
                "permissionModes": ["read_only", "workspace_write"]
            })
            .to_string(),
            Ok(Err(error)) => json!({
                "ok": false,
                "error": format!("无法启动 Qoder：{error}"),
                "executable": self.config.qoder_executable
            })
            .to_string(),
            Err(_) => json!({
                "ok": false,
                "error": "Qoder 版本检查超时。",
                "executable": self.config.qoder_executable
            })
            .to_string(),
        }
    }

    /// Delegate a coding or research task to Qoder in a constrained project workspace.
    #[tool(name = "delegate_task", annotations(title = "Delegate task to Qoder"))]
    async fn delegate_task(&self, Parameters(request): Parameters<DelegateTaskRequest>) -> String {
        match self.run_delegated_task(request).await {
            Ok(value) => value.to_string(),
            Err(error) => json!({ "ok": false, "error": error }).to_string(),
        }
    }

    async fn run_delegated_task(&self, request: DelegateTaskRequest) -> Result<Value, String> {
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err("任务内容不能为空。".to_string());
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(format!("任务内容不能超过 {MAX_PROMPT_BYTES} 字节。"));
        }
        let workspace = self
            .config
            .resolve_workspace(request.workspace.as_deref())?;
        let mode = request.mode.unwrap_or(DelegationMode::ReadOnly);
        let max_output_tokens = request
            .max_output_tokens
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
            .clamp(512, MAX_OUTPUT_TOKENS);

        let mut command = self.config.command();
        command
            .args(qoder_arguments(prompt, &workspace, mode, max_output_tokens))
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let output = timeout(self.config.task_timeout, command.output())
            .await
            .map_err(|_| {
                format!(
                    "Qoder 任务超过 {} 秒，已终止。",
                    self.config.task_timeout.as_secs()
                )
            })?
            .map_err(|error| format!("无法启动 Qoder：{error}"))?;
        let stdout = truncate_utf8(&String::from_utf8_lossy(&output.stdout), MAX_CAPTURE_BYTES);
        let stderr = truncate_utf8(&String::from_utf8_lossy(&output.stderr), MAX_CAPTURE_BYTES);
        let parsed_output = parse_qoder_output(stdout.trim());

        Ok(json!({
            "ok": output.status.success(),
            "exitCode": output.status.code(),
            "workspace": workspace,
            "permissionMode": mode.label(),
            "output": parsed_output,
            "stderr": stderr.trim()
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for QoderBridgeServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "通过受限工作区和无交互权限模式调用本机 Qoder CN CLI。delegate_task 可能修改工作区，调用前必须由宿主授权。",
        )
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = BridgeConfig::from_environment()?;
    QoderBridgeServer::new(config)
        .serve(stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

fn qoder_arguments(
    prompt: &str,
    workspace: &Path,
    mode: DelegationMode,
    max_output_tokens: u32,
) -> Vec<OsString> {
    let mut arguments = vec![
        "--print".into(),
        "--cwd".into(),
        workspace.as_os_str().to_owned(),
        "--output-format".into(),
        "json".into(),
        "--permission-mode".into(),
        mode.qoder_permission_mode().into(),
        "--max-output-tokens".into(),
        max_output_tokens.to_string().into(),
        "--no-session-persistence".into(),
    ];
    if matches!(mode, DelegationMode::ReadOnly) {
        arguments.extend([
            "--tools".into(),
            "Read".into(),
            "Grep".into(),
            "Glob".into(),
        ]);
    }
    arguments.push("--".into());
    arguments.push(prompt.into());
    arguments
}

fn discover_qoder_executable() -> PathBuf {
    if let Some(path) = env::var_os("QODERCLI_EXECUTABLE").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    #[cfg(windows)]
    if let Some(profile) = env::var_os("USERPROFILE") {
        let candidate = PathBuf::from(profile)
            .join(".qoder-cn")
            .join("bin")
            .join("qoderclicn")
            .join("qoderclicn.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(if cfg!(windows) {
        "qoderclicn.exe"
    } else {
        "qoderclicn"
    })
}

fn discover_git_bash() -> Option<PathBuf> {
    for name in [
        "QODER_BRIDGE_GIT_BASH_PATH",
        "QODERCN_GIT_BASH_PATH",
        "QODER_GIT_BASH_PATH",
    ] {
        if let Some(path) = env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_file())
        {
            return Some(path);
        }
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("where.exe")
            .arg("git.exe")
            .output()
            .ok()?;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let git = PathBuf::from(line.trim());
            let Some(root) = git.parent().and_then(Path::parent) else {
                continue;
            };
            let bash = root.join("bin").join("bash.exe");
            if bash.is_file() {
                return Some(bash);
            }
        }
    }
    None
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("{label}不存在或不可访问（{}）：{error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{label}不是目录：{}", canonical.display()));
    }
    Ok(canonical)
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let path = path.to_string_lossy().to_lowercase();
        let mut root = root.to_string_lossy().to_lowercase();
        if path == root {
            return true;
        }
        if !root.ends_with(['\\', '/']) {
            root.push(std::path::MAIN_SEPARATOR);
        }
        path.starts_with(&root)
    } else {
        path.starts_with(root)
    }
}

fn parse_qoder_output(source: &str) -> Value {
    if source.is_empty() {
        return Value::Null;
    }
    serde_json::from_str(source).unwrap_or_else(|_| Value::String(source.to_string()))
}

fn truncate_utf8(source: &str, max_bytes: usize) -> String {
    if source.len() <= max_bytes {
        return source.to_string();
    }
    let mut boundary = max_bytes;
    while !source.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}…[truncated]", &source[..boundary])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_config(root: &Path) -> BridgeConfig {
        BridgeConfig {
            qoder_executable: PathBuf::from("qoderclicn"),
            default_workspace: root.to_path_buf(),
            allowed_roots: vec![root.to_path_buf()],
            git_bash: None,
            task_timeout: Duration::from_secs(60),
        }
    }

    #[test]
    fn read_only_arguments_never_enable_permission_bypass() {
        let arguments = qoder_arguments(
            "inspect",
            Path::new("project"),
            DelegationMode::ReadOnly,
            2048,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().to_string())
        .collect::<Vec<_>>();
        assert!(arguments.contains(&"dont_ask".to_string()));
        assert!(arguments.contains(&"--tools".to_string()));
        assert!(!arguments.iter().any(|value| value.contains("bypass")));
        assert_eq!(arguments.last().map(String::as_str), Some("inspect"));
    }

    #[test]
    fn workspace_write_uses_auto_without_yolo() {
        let arguments = qoder_arguments(
            "fix it",
            Path::new("project"),
            DelegationMode::WorkspaceWrite,
            4096,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().to_string())
        .collect::<Vec<_>>();
        assert!(arguments.contains(&"auto".to_string()));
        assert!(!arguments.contains(&"--tools".to_string()));
        assert!(!arguments.iter().any(|value| value.contains("yolo")));
    }

    #[test]
    fn rejects_workspace_outside_allowed_root() {
        let base = env::temp_dir().join(format!("qoder-bridge-test-{}", std::process::id()));
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let config = test_config(&allowed.canonicalize().unwrap());
        let error = config
            .resolve_workspace(outside.to_str())
            .expect_err("outside path must be rejected");
        assert!(error.contains("不在桥接器允许的根目录"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn preserves_json_output_and_unicode_truncation() {
        assert_eq!(
            parse_qoder_output(r#"{"result":"ok"}"#)["result"],
            Value::String("ok".to_string())
        );
        assert_eq!(truncate_utf8("中文abc", 4), "中…[truncated]");
    }
}
