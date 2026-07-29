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
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
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
    launch: WorkerLaunch,
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

        let spawn_result = Command::new(&launch.program)
            .args(&launch.args)
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
                        launch.program.display()
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
        let mut run_requests = HashMap::<String, Value>::new();
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
                                &mut run_requests,
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
                            &mut WorkerLineContext {
                                stdin: &mut stdin,
                                worker_instance_id: &mut worker_instance_id,
                                active_run_ids: &mut active_run_ids,
                                run_requests: &mut run_requests,
                                pending_authorizations: &mut pending_authorizations,
                                data_directory: data_directory.clone(),
                            },
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
            run_requests.clear();
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
    run_requests: &mut HashMap<String, Value>,
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
                            "request": request.clone(),
                        }),
                    )
                    .await
                    {
                        Ok(()) => {
                            run_requests.insert(run_id.clone(), request.clone());
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

struct WorkerLineContext<'a> {
    stdin: &'a mut ChildStdin,
    worker_instance_id: &'a mut Option<String>,
    active_run_ids: &'a mut HashSet<String>,
    run_requests: &'a mut HashMap<String, Value>,
    pending_authorizations: &'a mut HashMap<String, String>,
    data_directory: Option<String>,
}

async fn handle_worker_line(
    app: &AppHandle,
    line: &str,
    context: &mut WorkerLineContext<'_>,
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
            *context.worker_instance_id = Some(id.clone());
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
            if context.worker_instance_id.as_deref() != Some(id) {
                return Err("heartbeat 来自未知 Worker 实例。".to_string());
            }
            update_snapshot(app, |snapshot| {
                snapshot.last_heartbeat_at = Some(now_millis());
                snapshot.active_run_ids = sorted_run_ids(context.active_run_ids);
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
                    context.active_run_ids.remove(run_id);
                    context.run_requests.remove(run_id);
                }
            }
            app.emit(RUN_EVENT, event)
                .map_err(|error| format!("无法转发 Runtime event：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(context.active_run_ids);
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
                context.active_run_ids.remove(run_id);
                context.run_requests.remove(run_id);
            }
            app.emit(MESSAGE_EVENT, message)
                .map_err(|error| format!("无法转发 Worker 消息：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(context.active_run_ids);
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
            context
                .pending_authorizations
                .insert(authorization_id.to_string(), request_id.to_string());
            app.emit(AUTHORIZATION_EVENT, message)
                .map_err(|error| format!("无法转发授权请求：{error}"))?;
            Ok(false)
        }
        "tool.invoke" => {
            let request = message
                .get("request")
                .ok_or_else(|| "tool.invoke 缺少 request。".to_string())?;
            let request_id = request
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.invoke 缺少 requestId。".to_string())?;
            app.emit(MESSAGE_EVENT, message.clone())
                .map_err(|error| format!("无法记录工具 RPC：{error}"))?;
            let run_id = request
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.invoke 缺少 runId。".to_string())?;
            let result = dispatch_worker_tool(
                app,
                context.data_directory.clone(),
                request,
                context.run_requests.get(run_id),
            )
            .await;
            write_message(
                context.stdin,
                &match result {
                    Ok(value) => json!({
                        "version": PROTOCOL_VERSION,
                        "type": "tool.result",
                        "requestId": request_id,
                        "result": { "ok": true, "value": value }
                    }),
                    Err(error) => json!({
                        "version": PROTOCOL_VERSION,
                        "type": "tool.result",
                        "requestId": request_id,
                        "result": {
                            "ok": false,
                            "error": crate::sensitive_data::redact_sensitive_text(&error),
                            "errorCode": "domain_tool_error",
                            "retryable": false
                        }
                    }),
                },
            )
            .await?;
            Ok(false)
        }
        "tool.record" => {
            let request_id = message
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.record 缺少 requestId。".to_string())?;
            let call = message
                .get("call")
                .ok_or_else(|| "tool.record 缺少 call。".to_string())?;
            record_worker_tool_call(app, context.data_directory.clone(), call).await?;
            write_message(
                context.stdin,
                &json!({
                    "version": PROTOCOL_VERSION,
                    "type": "tool.recorded",
                    "requestId": request_id
                }),
            )
            .await?;
            Ok(false)
        }
        "credential.request" => {
            let request = message
                .get("request")
                .ok_or_else(|| "credential.request 缺少 request。".to_string())?;
            let request_id = request
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| "credential.request 缺少 requestId。".to_string())?;
            let provider = request
                .get("provider")
                .and_then(Value::as_str)
                .ok_or_else(|| "credential.request 缺少 provider。".to_string())?;
            let state = app.state::<crate::secret_store::AiSecretState>();
            let credential = crate::secret_store::get_secret_value(app, &state, provider).await?;
            write_message(
                context.stdin,
                &json!({
                    "version": PROTOCOL_VERSION,
                    "type": "credential.result",
                    "requestId": request_id,
                    "credential": credential
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

async fn dispatch_worker_tool(
    app: &AppHandle,
    data_directory: Option<String>,
    request: &Value,
    run_request: Option<&Value>,
) -> Result<Value, String> {
    let tool_name = request
        .get("toolName")
        .and_then(Value::as_str)
        .ok_or_else(|| "tool.invoke 缺少 toolName。".to_string())?;
    let call_id = request
        .get("internalToolCallId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let arguments = request
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let source = request.get("source").and_then(Value::as_object);
    if source
        .and_then(|source| source.get("kind"))
        .and_then(Value::as_str)
        == Some("mcp")
    {
        let server_id = source
            .and_then(|source| source.get("serverId"))
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool source 缺少 serverId。".to_string())?;
        let source_tool_name = source
            .and_then(|source| source.get("toolName"))
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool source 缺少 toolName。".to_string())?;
        let arguments = arguments
            .as_object()
            .cloned()
            .ok_or_else(|| "MCP 工具参数必须是对象。".to_string())?;
        return crate::mcp::call_mcp_tool(crate::mcp::CallMcpToolInput {
            data_directory: effective_data_directory(app, data_directory)?,
            call_id,
            server_id: server_id.to_string(),
            tool_name: source_tool_name.to_string(),
            arguments,
        })
        .await;
    }

    match tool_name {
        "get_current_document" => {
            let document_id = current_document_id(run_request)?;
            execute_native_tool(
                app,
                data_directory,
                call_id,
                "read_document",
                json!({ "documentId": document_id, "maxChars": 65536 }),
            )
            .await
        }
        "get_selected_blocks" => {
            let document_id = current_document_id(run_request)?;
            let block_ids = context_block_ids(run_request, &document_id);
            if block_ids.is_empty() {
                return Ok(json!([]));
            }
            execute_native_tool(
                app,
                data_directory,
                call_id,
                "read_document",
                json!({
                    "documentId": document_id,
                    "blockIds": block_ids,
                    "maxChars": 65536
                }),
            )
            .await
            .map(|value| value.get("blocks").cloned().unwrap_or_else(|| json!([])))
        }
        "get_document_outline" => {
            let document_id = current_document_id(run_request)?;
            let document = execute_native_tool(
                app,
                data_directory,
                call_id,
                "read_document",
                json!({ "documentId": document_id, "maxChars": 65536 }),
            )
            .await?;
            Ok(Value::Array(
                document
                    .get("blocks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| {
                        block.get("blockType").and_then(Value::as_str) == Some("heading")
                    })
                    .map(|block| {
                        json!({
                            "id": block.get("id").cloned().unwrap_or(Value::Null),
                            "text": block.get("plainText").cloned().unwrap_or(Value::Null),
                            "index": block.get("blockIndex").cloned().unwrap_or(Value::Null)
                        })
                    })
                    .collect(),
            ))
        }
        "find_blocks_by_regex" => {
            let document_id = current_document_id(run_request)?;
            let document = execute_native_tool(
                app,
                data_directory.clone(),
                None,
                "read_document",
                json!({ "documentId": document_id, "maxChars": 65536 }),
            )
            .await?;
            let blocks = document
                .get("blocks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|block| {
                    json!({
                        "id": block.get("id").cloned().unwrap_or(Value::Null),
                        "type": block.get("blockType").cloned().unwrap_or(Value::Null),
                        "text": block.get("plainText").cloned().unwrap_or(Value::Null),
                        "index": block.get("blockIndex").cloned().unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>();
            let mut enriched = arguments.as_object().cloned().unwrap_or_default();
            enriched.insert("blocks".to_string(), Value::Array(blocks));
            execute_native_tool(
                app,
                data_directory,
                call_id,
                "find_blocks_by_regex",
                Value::Object(enriched),
            )
            .await
        }
        "read_skill_file" => {
            let values = arguments.as_object().cloned().unwrap_or_default();
            let skill_id = values
                .get("skillId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let relative_path = values
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            crate::skills::read_skill_file(
                app.clone(),
                crate::skills::SkillFileInput {
                    data_directory,
                    skill_id,
                    relative_path,
                    require_enabled: Some(true),
                },
            )
            .map(Value::String)
        }
        "search_documents"
        | "list_document_groups"
        | "read_document"
        | "execute_shell"
        | "inspect_environment_paths"
        | "discover_local_tools"
        | "get_system_info" => {
            execute_native_tool(app, data_directory, call_id, tool_name, arguments).await
        }
        "list_mind_maps"
        | "read_mind_map"
        | "create_automation_draft"
        | "create_skill_draft"
        | "create_mcp_server_draft" => Err(format!(
            "工具 {tool_name} 尚未迁移到 Rust Worker dispatcher。"
        )),
        other => Err(format!("Worker 不允许未注册的领域工具 {other}。")),
    }
}

async fn execute_native_tool(
    app: &AppHandle,
    data_directory: Option<String>,
    call_id: Option<String>,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let output = crate::agent_tools::execute_rig_tool(
        app.clone(),
        crate::agent_tools::ExecuteRigToolInput {
            data_directory,
            call_id,
            name: name.to_string(),
            arguments_json: serde_json::to_string(&arguments).map_err(worker_error)?,
        },
    )
    .await?;
    serde_json::from_str(&output).map_err(worker_error)
}

async fn record_worker_tool_call(
    app: &AppHandle,
    data_directory: Option<String>,
    call: &Value,
) -> Result<(), String> {
    let connection = database::open_database(app, data_directory).await?;
    let text = |name: &str| {
        call.get(name)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| format!("tool.record 缺少 {name}。"))
    };
    let optional_text = |name: &str| {
        call.get(name)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    };
    sqlx::query(
        "INSERT INTO agent_tool_calls (
           id, task_id, run_id, turn_id, provider_tool_call_id, tool_name,
           arguments_json, result_json, status, started_at, completed_at, error,
           correlation_id, causation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           result_json = excluded.result_json,
           status = excluded.status,
           completed_at = excluded.completed_at,
           error = excluded.error",
    )
    .bind(text("id")?)
    .bind(text("taskId")?)
    .bind(text("runId")?)
    .bind(optional_text("turnId"))
    .bind(optional_text("providerToolCallId"))
    .bind(text("toolName")?)
    .bind(text("argumentsJson")?)
    .bind(optional_text("resultJson"))
    .bind(text("status")?)
    .bind(
        call.get("startedAt")
            .and_then(Value::as_i64)
            .ok_or_else(|| "tool.record 缺少 startedAt。".to_string())?,
    )
    .bind(call.get("completedAt").and_then(Value::as_i64))
    .bind(optional_text("error"))
    .bind(text("runId")?)
    .bind(optional_text("turnId").or_else(|| {
        call.get("runId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    }))
    .execute(connection.as_ref())
    .await
    .map_err(database_error)?;
    Ok(())
}

fn current_document_id(run_request: Option<&Value>) -> Result<String, String> {
    run_request
        .and_then(|request| request.get("contextBundle"))
        .and_then(|bundle| bundle.get("scope"))
        .and_then(|scope| scope.get("documentId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "AgentRunRequest contextBundle 缺少当前 documentId。".to_string())
}

fn context_block_ids(run_request: Option<&Value>, document_id: &str) -> Vec<String> {
    run_request
        .and_then(|request| request.get("contextBundle"))
        .and_then(|bundle| bundle.get("sources"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|source| source.get("documentId").and_then(Value::as_str) == Some(document_id))
        .filter_map(|source| source.get("blockId").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect()
}

fn effective_data_directory(
    app: &AppHandle,
    data_directory: Option<String>,
) -> Result<String, String> {
    database::configured_data_directory(app, data_directory)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(worker_error)
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

struct WorkerLaunch {
    program: PathBuf,
    args: Vec<String>,
}

fn resolve_worker_program(app: &AppHandle) -> Result<WorkerLaunch, String> {
    if let Some(path) = env::var_os("MYNOTEBOOK_AGENT_WORKER_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(WorkerLaunch {
                program: path,
                args: Vec::new(),
            });
        }
        return Err(format!(
            "MYNOTEBOOK_AGENT_WORKER_PATH 指向的文件不存在：{}",
            path.display()
        ));
    }
    if cfg!(debug_assertions) {
        if let Some(script) = env::var_os("MYNOTEBOOK_AGENT_WORKER_SCRIPT") {
            let script = PathBuf::from(script);
            if !script.is_file() {
                return Err(format!(
                    "MYNOTEBOOK_AGENT_WORKER_SCRIPT 指向的文件不存在：{}",
                    script.display()
                ));
            }
            return Ok(WorkerLaunch {
                program: PathBuf::from(
                    env::var_os("MYNOTEBOOK_NODE_PATH").unwrap_or_else(|| "node".into()),
                ),
                args: vec![script.to_string_lossy().into_owned()],
            });
        }
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
        Ok(WorkerLaunch {
            program: path,
            args: Vec::new(),
        })
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
        let request = json!({
            "contextBundle": {
                "scope": { "documentId": "doc-1" },
                "sources": [
                    { "documentId": "doc-1", "blockId": "block-1" },
                    { "documentId": "doc-2", "blockId": "block-2" }
                ]
            }
        });
        assert_eq!(current_document_id(Some(&request)).unwrap(), "doc-1");
        assert_eq!(
            context_block_ids(Some(&request), "doc-1"),
            vec!["block-1".to_string()]
        );
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
