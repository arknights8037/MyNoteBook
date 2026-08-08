use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, RwLock};

use crate::core_server::{self, CoreEndpointDescriptor, CoreHealth};

const CORE_STATUS_EVENT: &str = "headless-core://status";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeadlessCoreSnapshot {
    status: String,
    instance_id: Option<String>,
    process_id: Option<u32>,
    protocol_major: u16,
    protocol_minor: u16,
    app_version: Option<String>,
    started_at: Option<i64>,
    last_error: Option<String>,
}

impl Default for HeadlessCoreSnapshot {
    fn default() -> Self {
        Self {
            status: "stopped".to_string(),
            instance_id: None,
            process_id: None,
            protocol_major: core_server::CORE_PROTOCOL_MAJOR,
            protocol_minor: core_server::CORE_PROTOCOL_MINOR,
            app_version: None,
            started_at: None,
            last_error: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct HeadlessCoreSupervisorState {
    launch: Mutex<()>,
    snapshot: RwLock<HeadlessCoreSnapshot>,
}

#[tauri::command]
pub(crate) async fn ensure_headless_core(
    app: AppHandle,
    state: State<'_, HeadlessCoreSupervisorState>,
) -> Result<HeadlessCoreSnapshot, String> {
    ensure_headless_core_inner(&app, state.inner()).await
}

#[tauri::command]
pub(crate) async fn get_headless_core_snapshot(
    state: State<'_, HeadlessCoreSupervisorState>,
) -> Result<HeadlessCoreSnapshot, String> {
    Ok(state.snapshot.read().await.clone())
}

pub(crate) async fn ensure_headless_core_inner(
    app: &AppHandle,
    state: &HeadlessCoreSupervisorState,
) -> Result<HeadlessCoreSnapshot, String> {
    let _launch = state.launch.lock().await;
    let directory = endpoint_directory(app)?;
    if let Ok(endpoint) = core_server::read_endpoint(&directory) {
        if let Ok(health) = core_server::negotiate_endpoint(&endpoint, "desktop").await {
            return publish_snapshot(app, state, running_snapshot(&health)).await;
        }
        let _ = core_server::shutdown_endpoint(&endpoint).await;
        for _ in 0..40 {
            if core_server::probe_endpoint(&endpoint).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    publish_snapshot(
        app,
        state,
        HeadlessCoreSnapshot {
            status: "starting".to_string(),
            protocol_major: core_server::CORE_PROTOCOL_MAJOR,
            protocol_minor: core_server::CORE_PROTOCOL_MINOR,
            ..HeadlessCoreSnapshot::default()
        },
    )
    .await?;
    spawn_core_process(&directory)?;
    let mut last_error = "Headless Core 未发布 endpoint。".to_string();
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let endpoint = match core_server::read_endpoint(&directory) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        match core_server::negotiate_endpoint(&endpoint, "desktop").await {
            Ok(health) => return publish_snapshot(app, state, running_snapshot(&health)).await,
            Err(error) => last_error = error,
        }
    }
    let snapshot = HeadlessCoreSnapshot {
        status: "unavailable".to_string(),
        protocol_major: core_server::CORE_PROTOCOL_MAJOR,
        protocol_minor: core_server::CORE_PROTOCOL_MINOR,
        last_error: Some(last_error.clone()),
        ..HeadlessCoreSnapshot::default()
    };
    let _ = publish_snapshot(app, state, snapshot).await;
    Err(last_error)
}

pub(crate) async fn active_endpoint(
    app: &AppHandle,
    state: &HeadlessCoreSupervisorState,
) -> Result<CoreEndpointDescriptor, String> {
    let directory = endpoint_directory(app)?;
    if let Ok(endpoint) = core_server::read_endpoint(&directory) {
        if core_server::negotiate_endpoint(&endpoint, "desktop")
            .await
            .is_ok()
        {
            return Ok(endpoint);
        }
    }
    ensure_headless_core_inner(app, state).await?;
    let endpoint = core_server::read_endpoint(&directory)?;
    core_server::negotiate_endpoint(&endpoint, "desktop").await?;
    Ok(endpoint)
}

fn endpoint_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("headless-core"))
        .map_err(|error| format!("解析 Headless Core 配置目录失败：{error}"))
}

fn spawn_core_process(endpoint_directory: &std::path::Path) -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("定位 Desktop 可执行文件失败：{error}"))?;
    let mut command = std::process::Command::new(executable);
    command
        .args(core_server::headless_core_arguments(endpoint_directory))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 Headless Core 进程失败：{error}"))
}

fn running_snapshot(health: &CoreHealth) -> HeadlessCoreSnapshot {
    HeadlessCoreSnapshot {
        status: "running".to_string(),
        instance_id: Some(health.instance_id.clone()),
        process_id: Some(health.process_id),
        protocol_major: health.protocol_major,
        protocol_minor: health.protocol_minor,
        app_version: Some(health.app_version.clone()),
        started_at: Some(health.started_at),
        last_error: None,
    }
}

async fn publish_snapshot(
    app: &AppHandle,
    state: &HeadlessCoreSupervisorState,
    snapshot: HeadlessCoreSnapshot,
) -> Result<HeadlessCoreSnapshot, String> {
    *state.snapshot.write().await = snapshot.clone();
    app.emit(CORE_STATUS_EVENT, &snapshot)
        .map_err(|error| format!("发布 Headless Core 状态失败：{error}"))?;
    Ok(snapshot)
}

#[allow(dead_code)]
fn endpoint_without_credential(endpoint: &CoreEndpointDescriptor) -> HeadlessCoreSnapshot {
    HeadlessCoreSnapshot {
        status: "discovered".to_string(),
        instance_id: Some(endpoint.instance_id.clone()),
        process_id: Some(endpoint.process_id),
        protocol_major: endpoint.protocol_major,
        protocol_minor: endpoint.protocol_minor,
        app_version: Some(endpoint.app_version.clone()),
        started_at: Some(endpoint.started_at),
        last_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_snapshot_does_not_serialize_the_instance_credential() {
        let endpoint = CoreEndpointDescriptor {
            instance_id: "core-test".to_string(),
            address: "127.0.0.1:1".to_string(),
            credential: "must-not-leak".to_string(),
            process_id: 1,
            protocol_major: 1,
            protocol_minor: 0,
            app_version: "0.1.0".to_string(),
            started_at: 1,
        };
        let serialized = serde_json::to_string(&endpoint_without_credential(&endpoint)).unwrap();
        assert!(!serialized.contains("must-not-leak"));
        assert!(!serialized.contains("credential"));
    }
}
