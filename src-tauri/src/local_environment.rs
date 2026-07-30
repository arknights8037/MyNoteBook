use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentVariable {
    name: String,
    value: String,
    category: &'static str,
    is_path_list: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentSnapshot {
    host_name: String,
    operating_system: String,
    architecture: String,
    shell: String,
    variables: Vec<LocalEnvironmentVariable>,
}

const SAFE_VARIABLES: &[(&str, &str, bool)] = &[
    ("USERPROFILE", "用户目录", false),
    ("HOME", "用户目录", false),
    ("APPDATA", "应用数据", false),
    ("LOCALAPPDATA", "应用数据", false),
    ("TEMP", "临时目录", false),
    ("TMP", "临时目录", false),
    ("PATH", "工具链", true),
    ("PATHEXT", "工具链", true),
    ("PNPM_HOME", "工具链", false),
    ("CARGO_HOME", "工具链", false),
    ("RUSTUP_HOME", "工具链", false),
    ("PROGRAMFILES", "系统目录", false),
    ("PROGRAMFILES(X86)", "系统目录", false),
    ("WINDIR", "系统目录", false),
    ("COMSPEC", "系统目录", false),
    ("SHELL", "系统目录", false),
    ("LANG", "区域设置", false),
    ("LC_ALL", "区域设置", false),
    ("NODE_ENV", "开发环境", false),
    ("MYNOTEBOOK_DATA_DIRECTORY", "myNoteBook", false),
];

#[tauri::command]
pub fn get_local_environment_snapshot() -> LocalEnvironmentSnapshot {
    build_snapshot(std::env::vars().collect())
}

fn build_snapshot(environment: HashMap<String, String>) -> LocalEnvironmentSnapshot {
    let environment = environment
        .into_iter()
        .map(|(name, value)| (name.to_ascii_uppercase(), value))
        .collect::<HashMap<_, _>>();
    let variables = SAFE_VARIABLES
        .iter()
        .filter_map(|(name, category, is_path_list)| {
            environment
                .get(*name)
                .filter(|value| !value.trim().is_empty())
                .map(|value| LocalEnvironmentVariable {
                    name: (*name).to_string(),
                    value: value.clone(),
                    category,
                    is_path_list: *is_path_list,
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
        variables,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_returns_explicitly_safe_environment_variables() {
        let environment = HashMap::from([
            ("COMPUTERNAME".to_string(), "WORKSTATION".to_string()),
            ("USERPROFILE".to_string(), r"C:\Users\demo".to_string()),
            ("PATH".to_string(), r"C:\Tools;C:\Windows".to_string()),
            (
                "OPENAI_API_KEY".to_string(),
                "should-never-leak".to_string(),
            ),
        ]);

        let snapshot = build_snapshot(environment);

        assert_eq!(snapshot.host_name, "WORKSTATION");
        assert_eq!(snapshot.variables.len(), 2);
        assert!(snapshot.variables.iter().any(|item| item.name == "PATH"));
        assert!(!snapshot
            .variables
            .iter()
            .any(|item| item.name.contains("KEY") || item.value.contains("leak")));
    }
}
