use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::{
    collections::{HashMap, HashSet},
    env,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex, RwLock},
    time::{interval, sleep, timeout},
};

use crate::database;

const PROTOCOL_VERSION: u64 = 1;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESTARTS: u32 = 3;
const STATUS_EVENT: &str = "agent-runtime://worker-status";
const MESSAGE_EVENT: &str = "agent-runtime://worker-message";
const RUN_EVENT: &str = "agent-runtime://event";
const AUTHORIZATION_EVENT: &str = "agent-runtime://authorization-request";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentWorkerStatus {
    Stopped,
    Starting,
    Running,
    Restarting,
    Crashed,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentWorkerSnapshot {
    status: AgentWorkerStatus,
    supervisor_instance_id: String,
    worker_instance_id: Option<String>,
    pid: Option<u32>,
    active_run_ids: Vec<String>,
    last_heartbeat_at: Option<i64>,
    restart_count: u32,
    last_error: Option<String>,
}

impl Default for AgentWorkerSnapshot {
    fn default() -> Self {
        Self {
            status: AgentWorkerStatus::Stopped,
            supervisor_instance_id: new_instance_id("supervisor"),
            worker_instance_id: None,
            pid: None,
            active_run_ids: Vec::new(),
            last_heartbeat_at: None,
            restart_count: 0,
            last_error: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct AgentWorkerSupervisorState {
    control: Mutex<Option<mpsc::Sender<SupervisorCommand>>>,
    snapshot: RwLock<AgentWorkerSnapshot>,
}

enum SupervisorCommand {
    StartRun {
        request: Value,
        response: oneshot::Sender<Result<(), String>>,
    },
    CancelRun {
        run_id: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SteerRun {
        run_id: String,
        input: Value,
        response: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reason: String,
        response: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartAgentWorkerInput {
    data_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartAgentRuntimeRunInput {
    data_directory: Option<String>,
    request: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelAgentRuntimeRunInput {
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteerAgentRuntimeRunInput {
    run_id: String,
    input: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShutdownAgentWorkerInput {
    reason: Option<String>,
}

#[tauri::command]
pub(crate) async fn start_agent_worker(
    app: AppHandle,
    state: State<'_, AgentWorkerSupervisorState>,
    input: StartAgentWorkerInput,
) -> Result<AgentWorkerSnapshot, String> {
    ensure_supervisor(&app, &state, input.data_directory).await?;
    Ok(state.snapshot.read().await.clone())
}

#[tauri::command]
pub(crate) async fn get_agent_worker_snapshot(
    state: State<'_, AgentWorkerSupervisorState>,
) -> Result<AgentWorkerSnapshot, String> {
    Ok(state.snapshot.read().await.clone())
}

#[tauri::command]
pub(crate) async fn start_agent_runtime_run(
    app: AppHandle,
    state: State<'_, AgentWorkerSupervisorState>,
    input: StartAgentRuntimeRunInput,
) -> Result<(), String> {
    let sender = ensure_supervisor(&app, &state, input.data_directory).await?;
    request_supervisor(&sender, |response| SupervisorCommand::StartRun {
        request: input.request,
        response,
    })
    .await
}

#[tauri::command]
pub(crate) async fn cancel_agent_runtime_run(
    state: State<'_, AgentWorkerSupervisorState>,
    input: CancelAgentRuntimeRunInput,
) -> Result<(), String> {
    let sender = supervisor_sender(&state).await?;
    request_supervisor(&sender, |response| SupervisorCommand::CancelRun {
        run_id: input.run_id,
        response,
    })
    .await
}

#[tauri::command]
pub(crate) async fn steer_agent_runtime_run(
    state: State<'_, AgentWorkerSupervisorState>,
    input: SteerAgentRuntimeRunInput,
) -> Result<(), String> {
    let sender = supervisor_sender(&state).await?;
    request_supervisor(&sender, |response| SupervisorCommand::SteerRun {
        run_id: input.run_id,
        input: input.input,
        response,
    })
    .await
}

#[tauri::command]
pub(crate) async fn shutdown_agent_worker(
    state: State<'_, AgentWorkerSupervisorState>,
    input: ShutdownAgentWorkerInput,
) -> Result<(), String> {
    let sender = supervisor_sender(&state).await?;
    request_supervisor(&sender, |response| SupervisorCommand::Shutdown {
        reason: input
            .reason
            .unwrap_or_else(|| "Tauri Core requested shutdown.".to_string()),
        response,
    })
    .await
}

async fn ensure_supervisor(
    app: &AppHandle,
    state: &AgentWorkerSupervisorState,
    data_directory: Option<String>,
) -> Result<mpsc::Sender<SupervisorCommand>, String> {
    let mut control = state.control.lock().await;
    if let Some(sender) = control.as_ref() {
        return Ok(sender.clone());
    }
    let program = resolve_worker_program(app)?;
    let (sender, receiver) = mpsc::channel(64);
    *control = Some(sender.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_supervisor(app.clone(), program, data_directory, receiver).await;
        let state = app.state::<AgentWorkerSupervisorState>();
        *state.control.lock().await = None;
    });
    Ok(sender)
}

async fn supervisor_sender(
    state: &AgentWorkerSupervisorState,
) -> Result<mpsc::Sender<SupervisorCommand>, String> {
    state
        .control
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "Agent Worker 尚未启动。".to_string())
}

async fn request_supervisor(
    sender: &mpsc::Sender<SupervisorCommand>,
    command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> SupervisorCommand,
) -> Result<(), String> {
    let (response_sender, response_receiver) = oneshot::channel();
    sender
        .send(command(response_sender))
        .await
        .map_err(|_| "Agent Worker Supervisor 已停止。".to_string())?;
    response_receiver
        .await
        .map_err(|_| "Agent Worker Supervisor 未返回结果。".to_string())?
}

async fn run_supervisor(
    app: AppHandle,
    program: PathBuf,
    data_directory: Option<String>,
    mut receiver: mpsc::Receiver<SupervisorCommand>,
) {
    let mut restart_count = 0u32;
    let mut claimed_run_ids = HashSet::new();
    let mut should_restart = true;

    while should_restart {
        update_snapshot(&app, |snapshot| {
            snapshot.status = if restart_count == 0 {
                AgentWorkerStatus::Starting
            } else {
                AgentWorkerStatus::Restarting
            };
            snapshot.restart_count = restart_count;
            snapshot.worker_instance_id = None;
            snapshot.pid = None;
            snapshot.last_heartbeat_at = None;
        })
        .await;

        let spawn_result = Command::new(&program)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawn_result {
            Ok(child) => child,
            Err(error) => {
                update_snapshot(&app, |snapshot| {
                    snapshot.status = AgentWorkerStatus::Unavailable;
                    snapshot.last_error = Some(format!(
                        "无法启动 Agent Worker {}：{error}",
                        program.display()
                    ));
                })
                .await;
                break;
            }
        };
        let pid = child.id();
        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.start_kill();
                update_snapshot(&app, |snapshot| {
                    snapshot.status = AgentWorkerStatus::Crashed;
                    snapshot.last_error = Some("Agent Worker stdin 不可用。".to_string());
                })
                .await;
                break;
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.start_kill();
                update_snapshot(&app, |snapshot| {
                    snapshot.status = AgentWorkerStatus::Crashed;
                    snapshot.last_error = Some("Agent Worker stdout 不可用。".to_string());
                })
                .await;
                break;
            }
        };
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!(
                        "[agent-worker] {}",
                        crate::sensitive_data::redact_sensitive_text(&line)
                    );
                }
            });
        }

        let supervisor_instance_id = app
            .state::<AgentWorkerSupervisorState>()
            .snapshot
            .read()
            .await
            .supervisor_instance_id
            .clone();
        if let Err(error) = write_message(
            &mut stdin,
            &json!({
                "version": PROTOCOL_VERSION,
                "type": "runtime.hello",
                "supervisorInstanceId": supervisor_instance_id,
                "protocolVersion": PROTOCOL_VERSION
            }),
        )
        .await
        {
            let _ = child.start_kill();
            update_snapshot(&app, |snapshot| {
                snapshot.status = AgentWorkerStatus::Crashed;
                snapshot.last_error = Some(error);
            })
            .await;
            break;
        }

        let mut lines = BufReader::new(stdout).lines();
        let mut heartbeat_check = interval(Duration::from_secs(2));
        let mut last_heartbeat = Instant::now();
        let mut worker_instance_id: Option<String> = None;
        let mut active_run_ids = HashSet::<String>::new();
        let mut pending_authorizations = HashMap::<String, String>::new();
        let mut intentional_shutdown = false;
        let mut exit_description = "stdout closed".to_string();

        update_snapshot(&app, |snapshot| {
            snapshot.status = AgentWorkerStatus::Starting;
            snapshot.pid = pid;
            snapshot.last_error = None;
        })
        .await;

        loop {
            tokio::select! {
                command = receiver.recv() => {
                    match command {
                        Some(command) => {
                            let outcome = handle_command(
                                command,
                                &mut stdin,
                                &mut active_run_ids,
                                &mut claimed_run_ids,
                                &mut pending_authorizations,
                            ).await;
                            if outcome.shutdown {
                                intentional_shutdown = true;
                                should_restart = false;
                                exit_description = outcome.reason;
                                let _ = child.start_kill();
                                break;
                            }
                        }
                        None => {
                            intentional_shutdown = true;
                            should_restart = false;
                            exit_description = "Supervisor command channel closed".to_string();
                            let _ = child.start_kill();
                            break;
                        }
                    }
                }
                line = lines.next_line() => {
                    match line {
                        Ok(Some(line)) => match handle_worker_line(
                            &app,
                            &line,
                            &mut stdin,
                            &mut worker_instance_id,
                            &mut active_run_ids,
                            &mut pending_authorizations,
                        ).await {
                            Ok(heartbeat) => {
                                if heartbeat {
                                    last_heartbeat = Instant::now();
                                }
                            }
                            Err(error) => {
                                exit_description = error;
                                let _ = child.start_kill();
                                break;
                            }
                        },
                        Ok(None) => break,
                        Err(error) => {
                            exit_description = format!("无法读取 Worker stdout：{error}");
                            break;
                        }
                    }
                }
                _ = heartbeat_check.tick() => {
                    if last_heartbeat.elapsed() > HEARTBEAT_TIMEOUT {
                        exit_description = format!(
                            "heartbeat timeout after {}ms",
                            HEARTBEAT_TIMEOUT.as_millis()
                        );
                        let _ = child.start_kill();
                        break;
                    }
                }
            }
        }

        let status = match timeout(Duration::from_secs(3), child.wait()).await {
            Ok(Ok(status)) => status.to_string(),
            Ok(Err(error)) => format!("wait error: {error}"),
            Err(_) => {
                let _ = child.kill().await;
                "forced termination after timeout".to_string()
            }
        };
        if !intentional_shutdown {
            exit_description = format!("{exit_description}; {status}");
            if let Ok(connection) = database::open_database(&app, data_directory.clone()).await {
                let active = active_run_ids.iter().cloned().collect::<Vec<_>>();
                let _ = handle_agent_worker_exit(
                    connection.as_ref(),
                    &active,
                    &exit_description,
                    now_millis(),
                )
                .await;
            }
            active_run_ids.clear();
            restart_count += 1;
            should_restart = restart_count <= MAX_RESTARTS;
            update_snapshot(&app, |snapshot| {
                snapshot.status = if should_restart {
                    AgentWorkerStatus::Restarting
                } else {
                    AgentWorkerStatus::Crashed
                };
                snapshot.worker_instance_id = None;
                snapshot.pid = None;
                snapshot.active_run_ids.clear();
                snapshot.restart_count = restart_count;
                snapshot.last_error = Some(exit_description.clone());
            })
            .await;
            if should_restart {
                sleep(Duration::from_millis(500 * 2u64.pow(restart_count - 1))).await;
            }
        } else {
            update_snapshot(&app, |snapshot| {
                snapshot.status = AgentWorkerStatus::Stopped;
                snapshot.worker_instance_id = None;
                snapshot.pid = None;
                snapshot.active_run_ids.clear();
                snapshot.last_error = None;
            })
            .await;
        }
    }
}

struct CommandOutcome {
    shutdown: bool,
    reason: String,
}

async fn handle_command(
    command: SupervisorCommand,
    stdin: &mut ChildStdin,
    active_run_ids: &mut HashSet<String>,
    claimed_run_ids: &mut HashSet<String>,
    pending_authorizations: &mut HashMap<String, String>,
) -> CommandOutcome {
    let mut shutdown = false;
    let mut reason = String::new();
    match command {
        SupervisorCommand::StartRun { request, response } => {
            let result = run_id_from_request(&request).and_then(|run_id| {
                if !claimed_run_ids.insert(run_id.clone()) {
                    return Err(format!("run_id {run_id} 已经启动。"));
                }
                Ok(run_id)
            });
            let result = match result {
                Ok(run_id) => {
                    let request_id = new_instance_id("run-request");
                    match write_message(
                        stdin,
                        &json!({
                            "version": PROTOCOL_VERSION,
                            "type": "run.start",
                            "requestId": request_id,
                            "request": request,
                        }),
                    )
                    .await
                    {
                        Ok(()) => {
                            active_run_ids.insert(run_id);
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            };
            let _ = response.send(result);
        }
        SupervisorCommand::CancelRun { run_id, response } => {
            let result = if active_run_ids.contains(&run_id) {
                write_message(
                    stdin,
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "type": "run.cancel",
                        "requestId": new_instance_id("cancel-request"),
                        "runId": run_id,
                    }),
                )
                .await
            } else {
                Err(format!("run_id {run_id} 未运行。"))
            };
            let _ = response.send(result);
        }
        SupervisorCommand::SteerRun {
            run_id,
            input,
            response,
        } => {
            let authorization_id = input
                .get("authorizationId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let answer = input
                .get("answer")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let result = if let (Some(authorization_id), Some(answer)) = (authorization_id, answer)
            {
                if let Some(request_id) = pending_authorizations.remove(&authorization_id) {
                    write_message(
                        stdin,
                        &json!({
                            "version": PROTOCOL_VERSION,
                            "type": "authorization.result",
                            "requestId": request_id,
                            "authorizationId": authorization_id,
                            "answer": answer,
                        }),
                    )
                    .await
                } else {
                    Err(format!(
                        "authorization_id {authorization_id} 不存在或已经结束。"
                    ))
                }
            } else if active_run_ids.contains(&run_id) {
                write_message(
                    stdin,
                    &json!({
                        "version": PROTOCOL_VERSION,
                        "type": "run.steer",
                        "requestId": new_instance_id("steer-request"),
                        "runId": run_id,
                        "input": input,
                    }),
                )
                .await
            } else {
                Err(format!("run_id {run_id} 未运行。"))
            };
            let _ = response.send(result);
        }
        SupervisorCommand::Shutdown {
            reason: shutdown_reason,
            response,
        } => {
            let result = write_message(
                stdin,
                &json!({
                    "version": PROTOCOL_VERSION,
                    "type": "shutdown",
                    "reason": shutdown_reason,
                }),
            )
            .await;
            let _ = response.send(result);
            shutdown = true;
            reason = shutdown_reason;
        }
    }
    CommandOutcome { shutdown, reason }
}

async fn handle_worker_line(
    app: &AppHandle,
    line: &str,
    stdin: &mut ChildStdin,
    worker_instance_id: &mut Option<String>,
    active_run_ids: &mut HashSet<String>,
    pending_authorizations: &mut HashMap<String, String>,
) -> Result<bool, String> {
    let message: Value = serde_json::from_str(line)
        .map_err(|error| format!("Agent Worker 返回无效 JSON：{error}"))?;
    if message.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("Agent Worker 协议版本不受支持。".to_string());
    }
    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent Worker 消息缺少 type。".to_string())?;
    match message_type {
        "runtime.hello" => {
            let identity = message
                .get("identity")
                .and_then(Value::as_object)
                .ok_or_else(|| "Agent Worker hello 缺少 identity。".to_string())?;
            if identity.get("runtime").and_then(Value::as_str) != Some("ai-sdk")
                || identity.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
            {
                return Err("Agent Worker identity 与 Phase 3 决策不兼容。".to_string());
            }
            let id = identity
                .get("workerInstanceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Agent Worker identity 缺少实例 ID。".to_string())?
                .to_string();
            *worker_instance_id = Some(id.clone());
            update_snapshot(app, |snapshot| {
                snapshot.status = AgentWorkerStatus::Running;
                snapshot.worker_instance_id = Some(id);
                snapshot.last_heartbeat_at = Some(now_millis());
                snapshot.last_error = None;
            })
            .await;
            Ok(true)
        }
        "heartbeat" => {
            let id = message
                .get("workerInstanceId")
                .and_then(Value::as_str)
                .ok_or_else(|| "heartbeat 缺少 workerInstanceId。".to_string())?;
            if worker_instance_id.as_deref() != Some(id) {
                return Err("heartbeat 来自未知 Worker 实例。".to_string());
            }
            update_snapshot(app, |snapshot| {
                snapshot.last_heartbeat_at = Some(now_millis());
                snapshot.active_run_ids = sorted_run_ids(active_run_ids);
            })
            .await;
            Ok(true)
        }
        "run.event" => {
            let event = message
                .get("event")
                .cloned()
                .ok_or_else(|| "run.event 缺少 event。".to_string())?;
            if is_terminal_event(&event) {
                if let Some(run_id) = event.get("runId").and_then(Value::as_str) {
                    active_run_ids.remove(run_id);
                }
            }
            app.emit(RUN_EVENT, event)
                .map_err(|error| format!("无法转发 Runtime event：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(active_run_ids);
            })
            .await;
            Ok(false)
        }
        "run.result" | "run.error" => {
            if let Some(run_id) = message
                .get("result")
                .and_then(|result| result.get("runId"))
                .and_then(Value::as_str)
                .or_else(|| message.get("runId").and_then(Value::as_str))
            {
                active_run_ids.remove(run_id);
            }
            app.emit(MESSAGE_EVENT, message)
                .map_err(|error| format!("无法转发 Worker 消息：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(active_run_ids);
            })
            .await;
            Ok(false)
        }
        "authorization.request" => {
            let request_id = message
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| "authorization.request 缺少 requestId。".to_string())?;
            let authorization_id = message
                .get("request")
                .and_then(|request| request.get("authorizationId"))
                .and_then(Value::as_str)
                .ok_or_else(|| "authorization.request 缺少 authorizationId。".to_string())?;
            pending_authorizations.insert(authorization_id.to_string(), request_id.to_string());
            app.emit(AUTHORIZATION_EVENT, message)
                .map_err(|error| format!("无法转发授权请求：{error}"))?;
            Ok(false)
        }
        "tool.invoke" => {
            let request_id = message
                .get("request")
                .and_then(|request| request.get("requestId"))
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.invoke 缺少 requestId。".to_string())?;
            app.emit(MESSAGE_EVENT, message.clone())
                .map_err(|error| format!("无法记录工具 RPC：{error}"))?;
            write_message(
                stdin,
                &json!({
                    "version": PROTOCOL_VERSION,
                    "type": "tool.result",
                    "requestId": request_id,
                    "result": {
                        "ok": false,
                        "error": "Rust Domain Tool dispatcher 尚未接入 Worker。",
                        "errorCode": "domain_tool_dispatcher_not_connected",
                        "retryable": false
                    }
                }),
            )
            .await?;
            Ok(false)
        }
        "run.cancelled" | "run.steered" | "shutdown" => {
            app.emit(MESSAGE_EVENT, message)
                .map_err(|error| format!("无法转发 Worker 消息：{error}"))?;
            Ok(false)
        }
        other => Err(format!("Agent Worker 消息类型 {other} 不受支持。")),
    }
}

async fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(message).map_err(worker_error)?;
    encoded.push(b'\n');
    stdin.write_all(&encoded).await.map_err(worker_error)?;
    stdin.flush().await.map_err(worker_error)
}

async fn update_snapshot(app: &AppHandle, update: impl FnOnce(&mut AgentWorkerSnapshot)) {
    let state = app.state::<AgentWorkerSupervisorState>();
    let snapshot = {
        let mut snapshot = state.snapshot.write().await;
        update(&mut snapshot);
        snapshot.clone()
    };
    let _ = app.emit(STATUS_EVENT, snapshot);
}

fn run_id_from_request(request: &Value) -> Result<String, String> {
    request
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "AgentRunRequest 缺少 runId。".to_string())
}

fn is_terminal_event(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("run.completed" | "run.failed" | "run.cancelled")
    )
}

fn sorted_run_ids(run_ids: &HashSet<String>) -> Vec<String> {
    let mut values = run_ids.iter().cloned().collect::<Vec<_>>();
    values.sort();
    values
}

fn resolve_worker_program(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MYNOTEBOOK_AGENT_WORKER_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "MYNOTEBOOK_AGENT_WORKER_PATH 指向的文件不存在：{}",
            path.display()
        ));
    }
    let filename = if cfg!(windows) {
        "agent-runtime-worker.exe"
    } else {
        "agent-runtime-worker"
    };
    let path = app
        .path()
        .resource_dir()
        .map_err(worker_error)?
        .join(filename);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "安装包中缺少自包含 Agent Worker：{}",
            path.display()
        ))
    }
}

fn new_instance_id(prefix: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{}-{timestamp}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn worker_error(error: impl std::fmt::Display) -> String {
    format!("Agent Worker 错误：{error}")
}

pub(crate) async fn handle_agent_worker_exit(
    connection: &SqlitePool,
    active_run_ids: &[String],
    exit_description: &str,
    interrupted_at: i64,
) -> Result<usize, String> {
    if active_run_ids.is_empty() {
        return Ok(0);
    }
    let error = format!("Agent Worker interrupted: {exit_description}");
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let mut updated = 0usize;
    for run_id in active_run_ids {
        let result = sqlx::query(
            "UPDATE agent_tasks \
             SET status = 'interrupted', current_step = 'Agent Worker 意外退出', \
                 error = ?, completed_at = ? \
             WHERE run_id = ? AND status IN ('pending', 'running')",
        )
        .bind(&error)
        .bind(interrupted_at)
        .bind(run_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        updated += result.rows_affected() as usize;
    }
    transaction.commit().await.map_err(database_error)?;
    Ok(updated)
}

fn database_error(error: sqlx::Error) -> String {
    format!("database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_run_identity_and_terminal_events() {
        assert_eq!(
            run_id_from_request(&json!({ "runId": "run-1" })).unwrap(),
            "run-1"
        );
        assert!(run_id_from_request(&json!({})).is_err());
        assert!(is_terminal_event(&json!({ "type": "run.completed" })));
        assert!(is_terminal_event(&json!({ "type": "run.failed" })));
        assert!(!is_terminal_event(&json!({ "type": "tool.completed" })));
    }

    #[tokio::test]
    async fn worker_crash_marks_only_active_runs_interrupted() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-agent-worker-crash-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = crate::database::get_pool_for_path(&path, true)
            .await
            .expect("open database");
        crate::database::DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("migrate");
        sqlx::query(
            "INSERT INTO documents (id, title, content_json, created_at, updated_at) \
             VALUES ('doc', 'Doc', '{\"type\":\"doc\",\"content\":[]}', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("document");
        for (id, run_id, status) in [
            ("active", "run-active", "running"),
            ("done", "run-done", "completed"),
        ] {
            sqlx::query(
                "INSERT INTO agent_tasks (id, run_id, session_id, document_id, status, user_instruction, \
                 context_scope, model, current_step, created_at) \
                 VALUES (?, ?, 'conversation', 'doc', ?, 'prototype', 'current_document', \
                 'faux', 'step', 1)",
            )
            .bind(id)
            .bind(run_id)
            .bind(status)
            .execute(pool.as_ref())
            .await
            .expect("task");
        }

        let updated = handle_agent_worker_exit(
            pool.as_ref(),
            &["run-active".to_string(), "run-done".to_string()],
            "exit code 17",
            99,
        )
        .await
        .expect("mark interrupted");
        assert_eq!(updated, 1);

        let active: (String, String, i64) = sqlx::query_as(
            "SELECT status, error, completed_at FROM agent_tasks WHERE run_id = 'run-active'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("active run");
        assert_eq!(active.0, "interrupted");
        assert!(active.1.contains("exit code 17"));
        assert_eq!(active.2, 99);
        let done: String =
            sqlx::query_scalar("SELECT status FROM agent_tasks WHERE run_id = 'run-done'")
                .fetch_one(pool.as_ref())
                .await
                .expect("done run");
        assert_eq!(done, "completed");
        let task_run_status: String = sqlx::query_scalar(
            "SELECT status FROM task_runs WHERE id = (SELECT task_run_id FROM agent_tasks WHERE run_id = 'run-active')",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("task run status");
        assert_eq!(task_run_status, "failed");

        drop(pool);
        crate::database::close_pool(&path)
            .await
            .expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
