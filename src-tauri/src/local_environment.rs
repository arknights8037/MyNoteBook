use futures_util::future::join_all;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{process::Command, time::timeout};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentVariable {
    name: String,
    value: String,
    label: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntime {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    version: String,
    executable: String,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentSnapshot {
    host_name: String,
    operating_system: String,
    architecture: String,
    shell: String,
    runtimes: Vec<LocalRuntime>,
    variables: Vec<LocalEnvironmentVariable>,
}

struct RuntimeSpec {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    command: &'static str,
    args: &'static [&'static str],
}

const SAFE_VARIABLES: &[(&str, &str)] = &[
    ("MYNOTEBOOK_DATA_DIRECTORY", "知识库数据"),
    ("USERPROFILE", "用户目录"),
    ("HOME", "用户目录"),
    ("LOCALAPPDATA", "应用数据"),
    ("PNPM_HOME", "pnpm 目录"),
    ("CARGO_HOME", "Cargo 目录"),
    ("RUSTUP_HOME", "Rustup 目录"),
    ("TEMP", "临时目录"),
];

const RUNTIME_SPECS: &[RuntimeSpec] = &[
    RuntimeSpec {
        id: "node",
        name: "Node.js",
        kind: "运行时",
        command: "node",
        args: &["--version"],
    },
    RuntimeSpec {
        id: "pnpm",
        name: "pnpm",
        kind: "包管理器",
        command: "pnpm",
        args: &["--version"],
    },
    RuntimeSpec {
        id: "rust",
        name: "Rust",
        kind: "编程语言",
        command: "rustc",
        args: &["--version"],
    },
    RuntimeSpec {
        id: "cargo",
        name: "Cargo",
        kind: "构建工具",
        command: "cargo",
        args: &["--version"],
    },
    RuntimeSpec {
        id: "python",
        name: "Python",
        kind: "编程语言",
        command: "python",
        args: &["--version"],
    },
    RuntimeSpec {
        id: "git",
        name: "Git",
        kind: "版本控制",
        command: "git",
        args: &["--version"],
    },
    RuntimeSpec {
        id: "go",
        name: "Go",
        kind: "编程语言",
        command: "go",
        args: &["version"],
    },
    RuntimeSpec {
        id: "java",
        name: "Java",
        kind: "运行时",
        command: "java",
        args: &["-version"],
    },
    RuntimeSpec {
        id: "docker",
        name: "Docker",
        kind: "容器工具",
        command: "docker",
        args: &["--version"],
    },
];

#[tauri::command]
pub async fn get_local_environment_snapshot() -> LocalEnvironmentSnapshot {
    let environment = normalize_environment(std::env::vars().collect());
    let runtimes = join_all(
        RUNTIME_SPECS
            .iter()
            .map(|spec| probe_runtime(spec, &environment)),
    )
    .await;
    build_snapshot(environment, runtimes)
}

fn normalize_environment(environment: HashMap<String, String>) -> HashMap<String, String> {
    environment
        .into_iter()
        .map(|(name, value)| (name.to_ascii_uppercase(), value))
        .collect()
}

fn build_snapshot(
    environment: HashMap<String, String>,
    runtimes: Vec<LocalRuntime>,
) -> LocalEnvironmentSnapshot {
    let mut seen_paths = HashSet::new();
    let variables = SAFE_VARIABLES
        .iter()
        .filter_map(|(name, label)| {
            let value = environment.get(*name)?.trim();
            if value.is_empty() || !seen_paths.insert(value.to_ascii_lowercase()) {
                return None;
            }
            Some(LocalEnvironmentVariable {
                name: (*name).to_string(),
                value: value.to_string(),
                label,
            })
        })
        .collect();

    let host_name = environment
        .get("COMPUTERNAME")
        .or_else(|| environment.get("HOSTNAME"))
        .cloned()
        .unwrap_or_else(|| "本机".to_string());
    let shell = environment
        .get("COMSPEC")
        .or_else(|| environment.get("SHELL"))
        .cloned()
        .unwrap_or_else(|| "未检测".to_string());

    LocalEnvironmentSnapshot {
        host_name,
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        shell,
        runtimes,
        variables,
    }
}

async fn probe_runtime(
    spec: &'static RuntimeSpec,
    environment: &HashMap<String, String>,
) -> LocalRuntime {
    let Some(executable) = resolve_command(spec.command, environment) else {
        return missing_runtime(spec);
    };
    let mut command = runtime_command(&executable, spec.args);
    let Ok(Ok(output)) = timeout(Duration::from_secs(2), command.output()).await else {
        return missing_runtime(spec);
    };
    if !output.status.success() {
        return missing_runtime(spec);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = first_output_line(if stdout.trim().is_empty() {
        stderr.as_ref()
    } else {
        stdout.as_ref()
    });
    if version.is_empty() {
        return missing_runtime(spec);
    }
    LocalRuntime {
        id: spec.id,
        name: spec.name,
        kind: spec.kind,
        version,
        executable: executable.to_string_lossy().into_owned(),
        available: true,
    }
}

fn missing_runtime(spec: &'static RuntimeSpec) -> LocalRuntime {
    LocalRuntime {
        id: spec.id,
        name: spec.name,
        kind: spec.kind,
        version: String::new(),
        executable: String::new(),
        available: false,
    }
}

fn first_output_line(output: &str) -> String {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(96)
        .collect()
}

fn resolve_command(command: &str, environment: &HashMap<String, String>) -> Option<PathBuf> {
    let path = environment.get("PATH")?;
    for directory in std::env::split_paths(OsStr::new(path)) {
        for candidate in command_candidates(&directory, command) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn command_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        ["exe", "cmd", "bat", "com"]
            .into_iter()
            .map(|extension| directory.join(format!("{command}.{extension}")))
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![directory.join(command)]
    }
}

fn runtime_command(executable: &Path, args: &[&str]) -> Command {
    #[cfg(target_os = "windows")]
    if matches!(
        executable.extension().and_then(OsStr::to_str),
        Some("cmd" | "bat")
    ) {
        let mut command = Command::new("cmd");
        command.args(["/d", "/c"]).arg(executable).args(args);
        return command;
    }
    let mut command = Command::new(executable);
    command.args(args);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_returns_distinct_explicitly_safe_paths() {
        let environment = normalize_environment(HashMap::from([
            ("ComputerName".to_string(), "WORKSTATION".to_string()),
            ("USERPROFILE".to_string(), r"C:\Users\demo".to_string()),
            ("HOME".to_string(), r"C:\Users\demo".to_string()),
            (
                "CARGO_HOME".to_string(),
                r"C:\Users\demo\.cargo".to_string(),
            ),
            (
                "OPENAI_API_KEY".to_string(),
                "should-never-leak".to_string(),
            ),
        ]));

        let snapshot = build_snapshot(environment, Vec::new());

        assert_eq!(snapshot.host_name, "WORKSTATION");
        assert_eq!(snapshot.variables.len(), 2);
        assert!(snapshot
            .variables
            .iter()
            .any(|item| item.name == "CARGO_HOME"));
        assert!(!snapshot
            .variables
            .iter()
            .any(|item| item.name.contains("KEY") || item.value.contains("leak")));
    }

    #[test]
    fn trims_tool_output_to_one_readable_line() {
        assert_eq!(
            first_output_line("\n  rustc 1.89.0  \nmore"),
            "rustc 1.89.0"
        );
        assert_eq!(first_output_line(""), "");
    }

    #[tokio::test]
    async fn detects_the_project_node_and_pnpm_toolchain() {
        let environment = normalize_environment(std::env::vars().collect());
        for id in ["node", "pnpm"] {
            let spec = RUNTIME_SPECS
                .iter()
                .find(|candidate| candidate.id == id)
                .expect("runtime spec");
            let runtime = probe_runtime(spec, &environment).await;
            assert!(runtime.available, "{id} should be available");
            assert!(!runtime.version.is_empty());
            assert!(!runtime.executable.is_empty());
        }
    }
}
