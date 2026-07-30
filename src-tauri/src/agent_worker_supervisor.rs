use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};
use std::{
    collections::{HashMap, HashSet},
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
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
    active_runs: Vec<Value>,
    pending_authorizations: Vec<Value>,
    pending_terminals: Vec<Value>,
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
            active_runs: Vec::new(),
            pending_authorizations: Vec::new(),
            pending_terminals: Vec::new(),
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
    terminal_messages: RwLock<HashMap<String, BufferedTerminal>>,
}

#[derive(Clone, Debug)]
struct BufferedTerminal {
    message: Value,
    projection: Value,
    recovery_context: Option<Value>,
}

enum SupervisorCommand {
    StartRun {
        request: Value,
        recovery_context: Option<Value>,
        response: oneshot::Sender<Result<(), String>>,
    },
    StartOrchestration {
        submission: Value,
        recovery_context: Option<Value>,
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
    recovery_context: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartAgentSidecarOrchestrationInput {
    data_directory: Option<String>,
    submission: Value,
    recovery_context: Option<Value>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeTerminalInput {
    run_id: String,
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
pub(crate) async fn get_agent_runtime_terminal(
    state: State<'_, AgentWorkerSupervisorState>,
    input: AgentRuntimeTerminalInput,
) -> Result<Option<Value>, String> {
    validate_run_id(&input.run_id)?;
    Ok(state
        .terminal_messages
        .read()
        .await
        .get(&input.run_id)
        .map(|terminal| {
            json!({
                "message": terminal.message.clone(),
                "recoveryContext": terminal.recovery_context.clone(),
            })
        }))
}

#[tauri::command]
pub(crate) async fn acknowledge_agent_runtime_terminal(
    app: AppHandle,
    state: State<'_, AgentWorkerSupervisorState>,
    input: AgentRuntimeTerminalInput,
) -> Result<(), String> {
    validate_run_id(&input.run_id)?;
    if state
        .terminal_messages
        .write()
        .await
        .remove(&input.run_id)
        .is_none()
    {
        return Err(format!("run_id {} 没有待确认终态。", input.run_id));
    }
    refresh_terminal_snapshot(&app).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_agent_runtime_run(
    app: AppHandle,
    state: State<'_, AgentWorkerSupervisorState>,
    input: StartAgentRuntimeRunInput,
) -> Result<(), String> {
    let sender = ensure_supervisor(&app, &state, input.data_directory.clone()).await?;
    request_supervisor(&sender, |response| SupervisorCommand::StartRun {
        request: input.request,
        recovery_context: input.recovery_context,
        response,
    })
    .await
}

#[tauri::command]
pub(crate) async fn start_agent_sidecar_orchestration(
    app: AppHandle,
    state: State<'_, AgentWorkerSupervisorState>,
    input: StartAgentSidecarOrchestrationInput,
) -> Result<(), String> {
    let sender = ensure_supervisor(&app, &state, input.data_directory.clone()).await?;
    let submission =
        enrich_sidecar_submission_with_mcp(&app, input.data_directory.clone(), input.submission)
            .await?;
    request_supervisor(&sender, |response| SupervisorCommand::StartOrchestration {
        submission,
        recovery_context: input.recovery_context,
        response,
    })
    .await
}

pub(crate) async fn start_background_orchestration(
    app: &AppHandle,
    data_directory: Option<String>,
    submission: Value,
    recovery_context: Value,
) -> Result<(), String> {
    let state = app.state::<AgentWorkerSupervisorState>();
    let sender = ensure_supervisor(app, &state, data_directory.clone()).await?;
    let submission = enrich_sidecar_submission_with_mcp(app, data_directory, submission).await?;
    request_supervisor(&sender, |response| SupervisorCommand::StartOrchestration {
        submission,
        recovery_context: Some(recovery_context),
        response,
    })
    .await
}

async fn enrich_sidecar_submission_with_mcp(
    app: &AppHandle,
    data_directory: Option<String>,
    mut submission: Value,
) -> Result<Value, String> {
    let directory = effective_data_directory(app, data_directory)?;
    let tools = crate::mcp::list_mcp_tools(crate::mcp::ListMcpToolsInput {
        data_directory: directory,
        server_id: None,
    })
    .await?;
    let external_tools = tools
        .into_iter()
        .map(|tool| {
            let runtime_name = format!(
                "mcp__{}__{}",
                safe_sidecar_tool_name(&tool.server_id),
                safe_sidecar_tool_name(&tool.name)
            );
            let trusted_read = tool.server_trusted && tool.read_only;
            json!({
                "serverId": tool.server_id,
                "serverName": tool.server_name,
                "name": tool.name,
                "runtimeName": runtime_name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "readOnly": tool.read_only,
                "serverTrusted": tool.server_trusted,
                "executionAuthorization": if trusted_read { "not_required" } else { "required" },
                "mutationApproval": "not_required",
                "externalActionApproval": "not_required",
                "maxCallsPerRun": 32,
                "tags": [if tool.read_only { "external.read" } else { "external.may_write" }],
                "presentation": { "label": tool.title.unwrap_or(tool.name), "category": "external" }
            })
        })
        .collect::<Vec<_>>();
    let object = submission
        .as_object_mut()
        .ok_or_else(|| "sidecar submission 必须是对象。".to_string())?;
    object.insert("externalTools".to_string(), Value::Array(external_tools));
    Ok(submission)
}

fn safe_sidecar_tool_name(value: &str) -> String {
    let normalized = value
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = normalized.trim_matches('_');
    if trimmed.is_empty() {
        "tool".to_string()
    } else {
        trimmed.to_string()
    }
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
        let stdin = Arc::new(Mutex::new(stdin));

        let mut lines = BufReader::new(stdout).lines();
        let mut heartbeat_check = interval(Duration::from_secs(2));
        let mut last_heartbeat = Instant::now();
        let mut worker_instance_id: Option<String> = None;
        let mut active_run_ids = HashSet::<String>::new();
        let mut run_requests = HashMap::<String, Value>::new();
        let mut run_recovery_contexts = HashMap::<String, Value>::new();
        let mut pending_authorizations = HashMap::<String, PendingAuthorization>::new();
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
                                &stdin,
                                &mut active_run_ids,
                                &mut claimed_run_ids,
                                &mut run_requests,
                                &mut run_recovery_contexts,
                                &mut pending_authorizations,
                            ).await;
                            update_snapshot(&app, |snapshot| {
                                snapshot.active_run_ids = sorted_run_ids(&active_run_ids);
                                snapshot.active_runs = sorted_active_runs(&run_requests);
                                snapshot.pending_authorizations =
                                    sorted_pending_authorizations(&pending_authorizations);
                            }).await;
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
                                stdin: Arc::clone(&stdin),
                                worker_instance_id: &mut worker_instance_id,
                                active_run_ids: &mut active_run_ids,
                                run_requests: &mut run_requests,
                                run_recovery_contexts: &mut run_recovery_contexts,
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
            for run_id in &active_run_ids {
                let terminal = json!({
                    "version": PROTOCOL_VERSION,
                    "type": "run.error",
                    "requestId": new_instance_id("worker-crash"),
                    "runId": run_id,
                    "error": {
                        "code": "worker_unavailable",
                        "message": crate::sensitive_data::redact_sensitive_text(&exit_description),
                        "retryable": true
                    }
                });
                let _ = buffer_terminal_message(
                    &app,
                    run_id,
                    &terminal,
                    run_requests.get(run_id),
                    run_recovery_contexts.get(run_id),
                )
                .await;
            }
            refresh_terminal_snapshot(&app).await;
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
            run_recovery_contexts.clear();
            pending_authorizations.clear();
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
                snapshot.active_runs.clear();
                snapshot.pending_authorizations.clear();
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
                snapshot.active_runs.clear();
                snapshot.pending_authorizations.clear();
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

struct PendingAuthorization {
    request_id: String,
    request: Value,
}

async fn handle_command(
    command: SupervisorCommand,
    stdin: &Arc<Mutex<ChildStdin>>,
    active_run_ids: &mut HashSet<String>,
    claimed_run_ids: &mut HashSet<String>,
    run_requests: &mut HashMap<String, Value>,
    run_recovery_contexts: &mut HashMap<String, Value>,
    pending_authorizations: &mut HashMap<String, PendingAuthorization>,
) -> CommandOutcome {
    let mut shutdown = false;
    let mut reason = String::new();
    match command {
        SupervisorCommand::StartRun {
            request,
            recovery_context,
            response,
        } => {
            let result = run_id_from_request(&request).and_then(|run_id| {
                if !claimed_run_ids.insert(run_id.clone()) {
                    return Err(format!("run_id {run_id} 已经启动。"));
                }
                Ok(run_id)
            });
            let result = match result {
                Ok(run_id) => {
                    let request_id = new_instance_id("run-request");
                    match write_shared_message(
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
                            if let Some(recovery_context) = recovery_context {
                                run_recovery_contexts.insert(run_id.clone(), recovery_context);
                            }
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
        SupervisorCommand::StartOrchestration {
            submission,
            recovery_context,
            response,
        } => {
            let result = run_id_from_request(&submission).and_then(|run_id| {
                if !claimed_run_ids.insert(run_id.clone()) {
                    return Err(format!("run_id {run_id} 已经启动。"));
                }
                Ok(run_id)
            });
            let result = match result {
                Ok(run_id) => {
                    let request_id = new_instance_id("orchestration-request");
                    match write_shared_message(
                        stdin,
                        &json!({
                            "version": PROTOCOL_VERSION,
                            "type": "orchestration.start",
                            "requestId": request_id,
                            "submission": submission.clone(),
                        }),
                    )
                    .await
                    {
                        Ok(()) => {
                            run_requests.insert(run_id.clone(), submission);
                            if let Some(recovery_context) = recovery_context {
                                run_recovery_contexts.insert(run_id.clone(), recovery_context);
                            }
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
                write_shared_message(
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
                if let Some(pending) = pending_authorizations.remove(&authorization_id) {
                    write_shared_message(
                        stdin,
                        &json!({
                            "version": PROTOCOL_VERSION,
                            "type": "authorization.result",
                            "requestId": pending.request_id,
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
                write_shared_message(
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
            let result = write_shared_message(
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
    stdin: Arc<Mutex<ChildStdin>>,
    worker_instance_id: &'a mut Option<String>,
    active_run_ids: &'a mut HashSet<String>,
    run_requests: &'a mut HashMap<String, Value>,
    run_recovery_contexts: &'a mut HashMap<String, Value>,
    pending_authorizations: &'a mut HashMap<String, PendingAuthorization>,
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
                snapshot.active_runs = sorted_active_runs(context.run_requests);
                snapshot.pending_authorizations =
                    sorted_pending_authorizations(context.pending_authorizations);
            })
            .await;
            Ok(true)
        }
        "orchestration.prepared" => {
            let request = message
                .get("request")
                .cloned()
                .ok_or_else(|| "orchestration.prepared 缺少 request。".to_string())?;
            let task = message
                .get("task")
                .cloned()
                .ok_or_else(|| "orchestration.prepared 缺少 task。".to_string())?;
            let run_id = run_id_from_request(&request)?;
            let task_run_id = task
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| "orchestration.prepared task 缺少 runId。".to_string())?;
            if task_run_id != run_id {
                return Err("orchestration.prepared 的 task/run 身份不一致。".to_string());
            }
            persist_sidecar_prepared_run(app, context.data_directory.clone(), &task, &request)
                .await?;
            if let Some(recovery) = context.run_recovery_contexts.get(&run_id) {
                let connection =
                    database::open_database(app, context.data_directory.clone()).await?;
                crate::agent_request_watcher::bind_background_request_task(
                    connection.as_ref(),
                    recovery,
                    task.get("id").and_then(Value::as_str).unwrap_or_default(),
                )
                .await?;
            }
            context.run_requests.insert(run_id, request);
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(context.active_run_ids);
                snapshot.active_runs = sorted_active_runs(context.run_requests);
            })
            .await;
            Ok(false)
        }
        "orchestration.completed" => {
            let finalization = message
                .get("finalization")
                .ok_or_else(|| "orchestration.completed 缺少 finalization。".to_string())?;
            let run_id = finalization
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| "orchestration.completed 缺少 runId。".to_string())?;
            let request = context
                .run_requests
                .get(run_id)
                .ok_or_else(|| format!("orchestration.completed 引用了未知 run_id {run_id}。"))?;
            if request.get("workItemId").and_then(Value::as_str)
                != finalization.get("taskId").and_then(Value::as_str)
            {
                return Err("orchestration.completed 的 task/run 身份不一致。".to_string());
            }
            persist_sidecar_finalization(app, context.data_directory.clone(), finalization).await?;
            Ok(false)
        }
        "run.event" => {
            let event = message
                .get("event")
                .cloned()
                .ok_or_else(|| "run.event 缺少 event。".to_string())?;
            app.emit(RUN_EVENT, event)
                .map_err(|error| format!("无法转发 Runtime event：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(context.active_run_ids);
                snapshot.active_runs = sorted_active_runs(context.run_requests);
                snapshot.pending_authorizations =
                    sorted_pending_authorizations(context.pending_authorizations);
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
                let run_request = context.run_requests.get(run_id).cloned();
                let recovery_context = context.run_recovery_contexts.get(run_id).cloned();
                if let Some(recovery) = recovery_context.as_ref() {
                    let connection =
                        database::open_database(app, context.data_directory.clone()).await?;
                    let task_id = run_request
                        .as_ref()
                        .and_then(|request| request.get("workItemId"))
                        .and_then(Value::as_str);
                    if message_type == "run.result" {
                        crate::agent_request_watcher::settle_background_run(
                            connection.as_ref(),
                            recovery,
                            task_id,
                            message.get("result"),
                            None,
                        )
                        .await?;
                    } else {
                        let error = message
                            .get("error")
                            .and_then(|value| value.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Agent Worker 运行失败。");
                        crate::agent_request_watcher::settle_background_run(
                            connection.as_ref(),
                            recovery,
                            task_id,
                            None,
                            Some(error),
                        )
                        .await?;
                    }
                }
                buffer_terminal_message(
                    app,
                    run_id,
                    &message,
                    run_request.as_ref(),
                    recovery_context.as_ref(),
                )
                .await?;
                context.active_run_ids.remove(run_id);
                context.run_requests.remove(run_id);
                context.run_recovery_contexts.remove(run_id);
                context.pending_authorizations.retain(|_, pending| {
                    pending.request.get("runId").and_then(Value::as_str) != Some(run_id)
                });
            }
            app.emit(MESSAGE_EVENT, message)
                .map_err(|error| format!("无法转发 Worker 消息：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.active_run_ids = sorted_run_ids(context.active_run_ids);
                snapshot.active_runs = sorted_active_runs(context.run_requests);
                snapshot.pending_authorizations =
                    sorted_pending_authorizations(context.pending_authorizations);
            })
            .await;
            refresh_terminal_snapshot(app).await;
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
            context.pending_authorizations.insert(
                authorization_id.to_string(),
                PendingAuthorization {
                    request_id: request_id.to_string(),
                    request: message
                        .get("request")
                        .cloned()
                        .ok_or_else(|| "authorization.request 缺少 request。".to_string())?,
                },
            );
            app.emit(AUTHORIZATION_EVENT, message)
                .map_err(|error| format!("无法转发授权请求：{error}"))?;
            update_snapshot(app, |snapshot| {
                snapshot.pending_authorizations =
                    sorted_pending_authorizations(context.pending_authorizations);
            })
            .await;
            Ok(false)
        }
        "tool.invoke" => {
            let request = message
                .get("request")
                .ok_or_else(|| "tool.invoke 缺少 request。".to_string())?;
            let request_id = request
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.invoke 缺少 requestId。".to_string())?
                .to_string();
            app.emit(MESSAGE_EVENT, message.clone())
                .map_err(|error| format!("无法记录工具 RPC：{error}"))?;
            let run_id = request
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.invoke 缺少 runId。".to_string())?;
            let request = request.clone();
            let run_request = context.run_requests.get(run_id).cloned();
            let data_directory = context.data_directory.clone();
            let app = app.clone();
            let stdin = Arc::clone(&context.stdin);
            tauri::async_runtime::spawn(async move {
                let result =
                    dispatch_worker_tool(&app, data_directory, &request, run_request.as_ref())
                        .await;
                let reply = match result {
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
                };
                if let Err(error) = write_shared_message(&stdin, &reply).await {
                    eprintln!(
                        "[agent-worker] {}",
                        crate::sensitive_data::redact_sensitive_text(&error)
                    );
                }
            });
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
            write_shared_message(
                &context.stdin,
                &json!({
                    "version": PROTOCOL_VERSION,
                    "type": "tool.recorded",
                    "requestId": request_id
                }),
            )
            .await?;
            Ok(false)
        }
        "tool.cancel" => {
            let call_id = message
                .get("internalToolCallId")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool.cancel 缺少 internalToolCallId。".to_string())?;
            crate::agent_cancellation::cancel_agent_tool_call(
                crate::agent_cancellation::CancelAgentToolCallInput {
                    call_id: call_id.to_string(),
                },
            )?;
            Ok(false)
        }
        "provider.request" => {
            let request = message
                .get("request")
                .cloned()
                .ok_or_else(|| "provider.request 缺少 request。".to_string())?;
            let run_id = request
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| "provider.request 缺少 runId。".to_string())?;
            let provider = context
                .run_requests
                .get(run_id)
                .and_then(|request| request.get("modelPolicy"))
                .and_then(|policy| policy.get("provider"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Provider 请求无法解析冻结的模型策略。".to_string())?
                .to_string();
            let stdin = Arc::clone(&context.stdin);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                proxy_worker_provider_request(&app, &stdin, request, &provider).await;
            });
            Ok(false)
        }
        "provider.cancel" => {
            let request_id = message
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| "provider.cancel 缺少 requestId。".to_string())?;
            crate::agent_cancellation::cancel_agent_tool_call(
                crate::agent_cancellation::CancelAgentToolCallInput {
                    call_id: request_id.to_string(),
                },
            )?;
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
        "replace_blocks_by_regex" => {
            let arguments = arguments
                .as_object()
                .cloned()
                .ok_or_else(|| "安全正则替换参数必须是对象。".to_string())?;
            execute_native_tool(
                app,
                data_directory,
                call_id,
                "replace_blocks_by_regex",
                Value::Object(arguments),
            )
            .await
        }
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
        "list_mind_maps" => {
            let connection = database::open_database(app, data_directory).await?;
            list_mind_maps_in_pool(connection.as_ref()).await
        }
        "read_mind_map" => {
            let connection = database::open_database(app, data_directory).await?;
            read_mind_map_in_pool(connection.as_ref(), &arguments).await
        }
        "create_automation_draft" => {
            let connection = database::open_database(app, data_directory).await?;
            create_automation_draft_in_pool(connection.as_ref(), &arguments, run_request).await
        }
        "create_skill_draft" => crate::skills::create_skill_draft(
            app.clone(),
            data_directory,
            required_argument_string(&arguments, "name")?,
            required_argument_string(&arguments, "description")?,
            required_argument_string(&arguments, "instructions")?,
        ),
        "create_mcp_server_draft" => crate::mcp::create_mcp_server_draft(
            &effective_data_directory(app, data_directory)?,
            &required_argument_string(&arguments, "name")?,
            &required_argument_string(&arguments, "transport")?,
            optional_argument_string(&arguments, "command")?,
            optional_argument_string_array(&arguments, "args", 64)?,
            optional_argument_string(&arguments, "cwd")?,
            optional_argument_string(&arguments, "url")?,
        ),
        other => Err(format!("Worker 不允许未注册的领域工具 {other}。")),
    }
}

async fn proxy_worker_provider_request(
    app: &AppHandle,
    stdin: &Arc<Mutex<ChildStdin>>,
    request: Value,
    provider: &str,
) {
    let request_id = request
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned);
    let Some(request_id) = request_id else {
        return;
    };
    let operation = async {
        let url = required_argument_string(&request, "url")?;
        let method = optional_argument_string(&request, "method")?;
        let body = request
            .get("body")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let mut headers = request
            .get("headers")
            .and_then(Value::as_object)
            .ok_or_else(|| "Provider 请求 headers 必须是对象。".to_string())?
            .iter()
            .map(|(name, value)| {
                value
                    .as_str()
                    .map(|value| (name.clone(), value.to_string()))
                    .ok_or_else(|| "Provider 请求 header 必须是字符串。".to_string())
            })
            .collect::<Result<HashMap<_, _>, String>>()?;
        let state = app.state::<crate::secret_store::AiSecretState>();
        let credential = crate::secret_store::get_secret_value(app, &state, provider).await?;
        inject_provider_credential(&mut headers, provider, credential);
        let mut response =
            crate::ai_proxy::start_ai_request(crate::ai_proxy::ProxyAiRequestInput {
                url,
                method,
                headers,
                body,
            })
            .await?;
        write_shared_message(
            stdin,
            &json!({
                "version": PROTOCOL_VERSION,
                "type": "provider.response.started",
                "requestId": request_id,
                "status": response.status,
                "headers": response.headers.clone()
            }),
        )
        .await?;
        while let Some(chunk) = response.next_chunk().await? {
            write_shared_message(
                stdin,
                &json!({
                    "version": PROTOCOL_VERSION,
                    "type": "provider.response.chunk",
                    "requestId": request_id,
                    "bodyBase64": BASE64_STANDARD.encode(chunk)
                }),
            )
            .await?;
        }
        write_shared_message(
            stdin,
            &json!({
                "version": PROTOCOL_VERSION,
                "type": "provider.response.completed",
                "requestId": request_id
            }),
        )
        .await
    };
    let result =
        match crate::agent_cancellation::ToolCancellationGuard::register(request_id.clone()) {
            Ok(cancellation) => tokio::select! {
                result = operation => result,
                _ = cancellation.cancelled() => Err("Provider 请求已取消。".to_string()),
            },
            Err(error) => Err(error),
        };
    if let Err(error) = result {
        let _ = write_shared_message(
            stdin,
            &json!({
                "version": PROTOCOL_VERSION,
                "type": "provider.response.failed",
                "requestId": request_id,
                "error": crate::sensitive_data::redact_sensitive_text(&error)
            }),
        )
        .await;
    }
}

fn inject_provider_credential(
    headers: &mut HashMap<String, String>,
    provider: &str,
    credential: String,
) {
    headers.retain(|name, _| {
        !matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization" | "x-api-key"
        )
    });
    if provider == "anthropic" {
        headers.insert("x-api-key".to_string(), credential);
    } else {
        headers.insert("authorization".to_string(), format!("Bearer {credential}"));
    }
}

async fn list_mind_maps_in_pool(connection: &SqlitePool) -> Result<Value, String> {
    let rows = sqlx::query(
        "SELECT id, parent_id, sort_order, title, content_json, version, created_at, updated_at \
         FROM mind_maps ORDER BY updated_at DESC, id ASC",
    )
    .fetch_all(connection)
    .await
    .map_err(database_error)?;
    rows.into_iter()
        .map(|row| {
            let content: Value = serde_json::from_str(
                &row.try_get::<String, _>("content_json")
                    .map_err(database_error)?,
            )
            .map_err(|error| format!("思维导图数据损坏：{error}"))?;
            let root_node_id = content
                .get("rootNodeId")
                .and_then(Value::as_str)
                .ok_or_else(|| "思维导图缺少 rootNodeId。".to_string())?;
            let node_count = content
                .get("nodes")
                .and_then(Value::as_object)
                .ok_or_else(|| "思维导图缺少 nodes。".to_string())?
                .len();
            Ok(json!({
                "id": row.try_get::<String, _>("id").map_err(database_error)?,
                "parentId": row.try_get::<Option<String>, _>("parent_id").map_err(database_error)?,
                "sortOrder": row.try_get::<i64, _>("sort_order").map_err(database_error)?,
                "title": row.try_get::<String, _>("title").map_err(database_error)?,
                "rootNodeId": root_node_id,
                "nodeCount": node_count,
                "version": row.try_get::<i64, _>("version").map_err(database_error)?,
                "createdAt": row.try_get::<i64, _>("created_at").map_err(database_error)?,
                "updatedAt": row.try_get::<i64, _>("updated_at").map_err(database_error)?
            }))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(Value::Array)
}

async fn read_mind_map_in_pool(
    connection: &SqlitePool,
    arguments: &Value,
) -> Result<Value, String> {
    let mind_map_id = required_argument_string(arguments, "mindMapId")?;
    let row =
        sqlx::query("SELECT id, title, content_json, version FROM mind_maps WHERE id = ? LIMIT 1")
            .bind(&mind_map_id)
            .fetch_optional(connection)
            .await
            .map_err(database_error)?
            .ok_or_else(|| format!("思维导图 {mind_map_id} 不存在或不可读取。"))?;
    let content: Value = serde_json::from_str(
        &row.try_get::<String, _>("content_json")
            .map_err(database_error)?,
    )
    .map_err(|error| format!("思维导图数据损坏：{error}"))?;
    project_mind_map_subtree(
        &mind_map_id,
        &row.try_get::<String, _>("title").map_err(database_error)?,
        row.try_get::<i64, _>("version").map_err(database_error)?,
        &content,
        arguments,
    )
}

fn project_mind_map_subtree(
    mind_map_id: &str,
    title: &str,
    version: i64,
    content: &Value,
    arguments: &Value,
) -> Result<Value, String> {
    let nodes = content
        .get("nodes")
        .and_then(Value::as_object)
        .ok_or_else(|| "思维导图缺少 nodes。".to_string())?;
    let root_node_id = optional_argument_string(arguments, "nodeId")?.unwrap_or(
        content
            .get("rootNodeId")
            .and_then(Value::as_str)
            .ok_or_else(|| "思维导图缺少 rootNodeId。".to_string())?
            .to_string(),
    );
    if !nodes.contains_key(&root_node_id) {
        return Err(format!("节点 {root_node_id} 不存在。"));
    }
    let max_depth = optional_bounded_u64(arguments, "depth", 0, 32)?.unwrap_or(3);
    let max_nodes = optional_bounded_u64(arguments, "maxNodes", 1, 1_000)?.unwrap_or(100);
    let include_notes = argument_object(arguments)?
        .get("includeNotes")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_sources = argument_object(arguments)?
        .get("includeSources")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut children = HashMap::<String, Vec<String>>::new();
    for (node_id, node) in nodes {
        if let Some(parent_id) = node.get("parentId").and_then(Value::as_str) {
            children
                .entry(parent_id.to_string())
                .or_default()
                .push(node_id.clone());
        }
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            let left_order = nodes
                .get(left)
                .and_then(|node| node.get("order"))
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let right_order = nodes
                .get(right)
                .and_then(|node| node.get("order"))
                .and_then(Value::as_i64)
                .unwrap_or_default();
            left_order.cmp(&right_order).then_with(|| left.cmp(right))
        });
    }
    let mut returned_nodes = 0_u64;
    let mut truncated = false;
    let root = project_mind_map_node(
        &root_node_id,
        0,
        max_depth,
        max_nodes,
        nodes,
        &children,
        include_notes,
        include_sources,
        &mut returned_nodes,
        &mut truncated,
    )?;
    Ok(json!({
        "mindMapId": mind_map_id,
        "title": title,
        "version": version,
        "root": root,
        "returnedNodes": returned_nodes,
        "truncated": truncated
    }))
}

#[allow(clippy::too_many_arguments)]
fn project_mind_map_node(
    node_id: &str,
    depth: u64,
    max_depth: u64,
    max_nodes: u64,
    nodes: &Map<String, Value>,
    children: &HashMap<String, Vec<String>>,
    include_notes: bool,
    include_sources: bool,
    returned_nodes: &mut u64,
    truncated: &mut bool,
) -> Result<Value, String> {
    let node = nodes
        .get(node_id)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("思维导图节点 {node_id} 无效。"))?;
    *returned_nodes += 1;
    let mut result = Map::from_iter([
        ("id".to_string(), Value::String(node_id.to_string())),
        (
            "text".to_string(),
            Value::String(
                node.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
        ),
        ("children".to_string(), Value::Array(Vec::new())),
    ]);
    if include_notes {
        if let Some(note) = node
            .get("note")
            .and_then(Value::as_str)
            .filter(|note| !note.is_empty())
        {
            result.insert("note".to_string(), Value::String(note.to_string()));
        }
    }
    if include_sources {
        if let Some(source_refs) = node
            .get("sourceRefs")
            .and_then(Value::as_array)
            .filter(|sources| !sources.is_empty())
        {
            result.insert("sourceRefs".to_string(), Value::Array(source_refs.clone()));
        }
    }
    let child_ids = children.get(node_id).map(Vec::as_slice).unwrap_or_default();
    if depth >= max_depth {
        *truncated |= !child_ids.is_empty();
        return Ok(Value::Object(result));
    }
    let projected_children = result
        .get_mut("children")
        .and_then(Value::as_array_mut)
        .expect("children is initialized as an array");
    for child_id in child_ids {
        if *returned_nodes >= max_nodes {
            *truncated = true;
            break;
        }
        projected_children.push(project_mind_map_node(
            child_id,
            depth + 1,
            max_depth,
            max_nodes,
            nodes,
            children,
            include_notes,
            include_sources,
            returned_nodes,
            truncated,
        )?);
    }
    Ok(Value::Object(result))
}

async fn create_automation_draft_in_pool(
    connection: &SqlitePool,
    arguments: &Value,
    run_request: Option<&Value>,
) -> Result<Value, String> {
    let name = required_argument_string(arguments, "name")?;
    let instruction = required_argument_string(arguments, "instruction")?;
    let trigger_type = required_argument_string(arguments, "triggerType")?;
    let trigger_config = match trigger_type.as_str() {
        "manual" => json!({}),
        "interval" => json!({
            "intervalMinutes": required_bounded_u64(arguments, "intervalMinutes", 5, 10_080)?
        }),
        "daily" => {
            let daily_time = required_argument_string(arguments, "dailyTime")?;
            if !valid_daily_time(&daily_time) {
                return Err("工具参数 dailyTime 必须是 HH:mm 格式。".to_string());
            }
            json!({ "dailyTime": daily_time })
        }
        _ => return Err("工具参数 triggerType 必须是 manual、interval 或 daily。".to_string()),
    };
    let bind_current_document = argument_object(arguments)?
        .get("bindCurrentDocument")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let document_id = if bind_current_document {
        Some(current_document_id(run_request)?)
    } else {
        None
    };
    let id = new_instance_id("automation");
    let created_at = now_millis();
    sqlx::query(
        "INSERT INTO automation_tasks (id, name, instruction, trigger_type, trigger_config_json, \
         document_id, enabled, next_run_at, last_run_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)",
    )
    .bind(&id)
    .bind(name.trim())
    .bind(instruction.trim())
    .bind(&trigger_type)
    .bind(serde_json::to_string(&trigger_config).map_err(worker_error)?)
    .bind(document_id)
    .bind(created_at)
    .bind(created_at)
    .execute(connection)
    .await
    .map_err(database_error)?;
    Ok(json!({ "created": true, "id": id, "name": name.trim(), "enabled": false }))
}

fn argument_object(arguments: &Value) -> Result<&Map<String, Value>, String> {
    arguments
        .as_object()
        .ok_or_else(|| "工具参数必须是对象。".to_string())
}

fn required_argument_string(arguments: &Value, name: &str) -> Result<String, String> {
    optional_argument_string(arguments, name)?
        .ok_or_else(|| format!("工具参数 {name} 必须是非空字符串。"))
}

fn optional_argument_string(arguments: &Value, name: &str) -> Result<Option<String>, String> {
    match argument_object(arguments)?.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        _ => Err(format!("工具参数 {name} 必须是非空字符串。")),
    }
}

fn optional_argument_string_array(
    arguments: &Value,
    name: &str,
    maximum_items: usize,
) -> Result<Vec<String>, String> {
    let Some(value) = argument_object(arguments)?.get(name) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("工具参数 {name} 必须是字符串数组。"))?;
    if values.len() > maximum_items {
        return Err(format!("工具参数 {name} 最多包含 {maximum_items} 项。"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("工具参数 {name} 必须是字符串数组。"))
        })
        .collect()
}

fn optional_bounded_u64(
    arguments: &Value,
    name: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>, String> {
    match argument_object(arguments)?.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|value| (*value >= minimum) && (*value <= maximum))
            .map(Some)
            .ok_or_else(|| format!("工具参数 {name} 必须是 {minimum}–{maximum} 的整数。")),
    }
}

fn required_bounded_u64(
    arguments: &Value,
    name: &str,
    minimum: u64,
    maximum: u64,
) -> Result<u64, String> {
    optional_bounded_u64(arguments, name, minimum, maximum)?
        .ok_or_else(|| format!("工具参数 {name} 不能为空。"))
}

fn valid_daily_time(value: &str) -> bool {
    let Some((hour, minute)) = value.split_once(':') else {
        return false;
    };
    hour.len() == 2
        && minute.len() == 2
        && hour.parse::<u8>().is_ok_and(|value| value < 24)
        && minute.parse::<u8>().is_ok_and(|value| value < 60)
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

async fn write_shared_message(
    stdin: &Arc<Mutex<ChildStdin>>,
    message: &Value,
) -> Result<(), String> {
    write_message(&mut *stdin.lock().await, message).await
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

async fn persist_sidecar_prepared_run(
    app: &AppHandle,
    data_directory: Option<String>,
    task: &Value,
    request: &Value,
) -> Result<(), String> {
    let connection = database::open_database(app, data_directory).await?;
    persist_sidecar_prepared_run_in_pool(connection.as_ref(), task, request).await
}

async fn persist_sidecar_prepared_run_in_pool(
    connection: &SqlitePool,
    task: &Value,
    request: &Value,
) -> Result<(), String> {
    let required_task_string = |name: &str| {
        task.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| format!("sidecar task 缺少 {name}。"))
    };
    let task_id = required_task_string("id")?;
    let run_id = required_task_string("runId")?;
    let session_id = required_task_string("sessionId")?;
    let document_id = required_task_string("documentId")?;
    let user_instruction = required_task_string("userInstruction")?;
    let model = required_task_string("model")?;
    let context_bundle = request
        .get("contextBundle")
        .and_then(Value::as_object)
        .ok_or_else(|| "sidecar request 缺少 contextBundle。".to_string())?;
    let bundle_id = context_bundle
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "sidecar contextBundle 缺少 id。".to_string())?;
    let bundle_task_id = context_bundle
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| "sidecar contextBundle 缺少 taskId。".to_string())?;
    if bundle_task_id != task_id {
        return Err("sidecar contextBundle 的 taskId 不匹配。".to_string());
    }
    let execution_policy = task
        .get("executionPolicy")
        .cloned()
        .ok_or_else(|| "sidecar task 缺少 executionPolicy。".to_string())?;
    let bundle_json = |name: &str| -> Result<String, String> {
        Ok(context_bundle
            .get(name)
            .cloned()
            .unwrap_or_else(|| json!([]))
            .to_string())
    };
    let created_at = task
        .get("createdAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_millis);
    let mut transaction = connection.begin().await.map_err(database_error)?;
    sqlx::query(
        "INSERT INTO agent_tasks (id, run_id, workflow_id, session_id, document_id, status, user_instruction, \
         context_scope, model, current_step, error, created_at, completed_at, correlation_id, causation_id, \
         execution_policy_json, context_bundle_id, provider, project_id, conversation_id) \
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, workflow_id = excluded.workflow_id, \
         session_id = excluded.session_id, document_id = excluded.document_id, status = 'running', \
         current_step = excluded.current_step, error = NULL, execution_policy_json = excluded.execution_policy_json, \
         context_bundle_id = excluded.context_bundle_id, provider = excluded.provider, project_id = excluded.project_id, \
         conversation_id = excluded.conversation_id",
    )
    .bind(&task_id)
    .bind(&run_id)
    .bind(task.get("workflowId").and_then(Value::as_str))
    .bind(&session_id)
    .bind(&document_id)
    .bind(&user_instruction)
    .bind(task.get("contextScope").and_then(Value::as_str).unwrap_or("current_document"))
    .bind(&model)
    .bind(task.get("currentStep").and_then(Value::as_str).unwrap_or("侧车正在运行"))
    .bind(created_at)
    .bind(task.get("correlationId").and_then(Value::as_str).unwrap_or(&task_id))
    .bind(task.get("causationId").and_then(Value::as_str))
    .bind(execution_policy.to_string())
    .bind(Option::<&str>::None)
    .bind(task.get("provider").and_then(Value::as_str).unwrap_or("openai"))
    .bind(task.get("projectId").and_then(Value::as_str).unwrap_or(""))
    .bind(task.get("conversationId").and_then(Value::as_str).unwrap_or(""))
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO context_bundles (id, task_id, run_id, version, scope_json, permission_snapshot_json, \
         sources_json, active_rules_json, decisions_json, conflicts_json, compiler_json, snapshot_hash, \
         correlation_id, causation_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(task_id, snapshot_hash) DO NOTHING",
    )
    .bind(bundle_id)
    .bind(&task_id)
    .bind(&run_id)
    .bind(context_bundle.get("version").and_then(Value::as_i64).unwrap_or(2))
    .bind(bundle_json("scope")?)
    .bind(bundle_json("permissionSnapshot")?)
    .bind(bundle_json("sources")?)
    .bind(bundle_json("activeRules")?)
    .bind(bundle_json("decisions")?)
    .bind(bundle_json("conflicts")?)
    .bind(bundle_json("compiler")?)
    .bind(context_bundle.get("snapshotHash").and_then(Value::as_str).unwrap_or(""))
    .bind(context_bundle.get("correlationId").and_then(Value::as_str).unwrap_or(&task_id))
    .bind(context_bundle.get("causationId").and_then(Value::as_str))
    .bind(context_bundle.get("createdAt").and_then(Value::as_i64).unwrap_or(created_at))
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    let persisted_bundle_id: String = sqlx::query_scalar(
        "SELECT id FROM context_bundles WHERE task_id = ? AND snapshot_hash = ? LIMIT 1",
    )
    .bind(&task_id)
    .bind(
        context_bundle
            .get("snapshotHash")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("UPDATE agent_tasks SET context_bundle_id = ? WHERE id = ?")
        .bind(persisted_bundle_id)
        .bind(&task_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)
}

/// Persists the sidecar's proposal projection before the terminal is exposed
/// to a WebView. Document application remains in agent_repository's existing
/// revision-checked transaction commands.
async fn persist_sidecar_finalization(
    app: &AppHandle,
    data_directory: Option<String>,
    finalization: &Value,
) -> Result<(), String> {
    let connection = database::open_database(app, data_directory).await?;
    let task_id = required_finalization_string(finalization, "taskId")?;
    let run_id = required_finalization_string(finalization, "runId")?;
    let outcome = required_finalization_string(finalization, "outcome")?;
    if !matches!(outcome.as_str(), "proposal" | "no_change" | "blocked") {
        return Err("sidecar finalization 的 outcome 无效。".to_string());
    }
    let status = required_finalization_string(finalization, "taskStatus")?;
    if !matches!(status.as_str(), "waiting_confirmation" | "completed") {
        return Err("sidecar finalization 的 taskStatus 无效。".to_string());
    }
    let current_step = required_finalization_string(finalization, "currentStep")?;
    let completed_at = finalization.get("completedAt").and_then(Value::as_i64);
    let patches = finalization
        .get("patches")
        .and_then(Value::as_array)
        .ok_or_else(|| "sidecar finalization 缺少 patches。".to_string())?;
    let sources = finalization
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| "sidecar finalization 缺少 sources。".to_string())?;
    if (status == "waiting_confirmation") == patches.is_empty() {
        return Err("sidecar finalization 的任务状态与 Patch 不一致。".to_string());
    }

    let created_at = now_millis();
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let task_exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM agent_tasks WHERE id = ? AND run_id = ? LIMIT 1")
            .bind(&task_id)
            .bind(&run_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database_error)?;
    if task_exists.is_none() {
        return Err("sidecar finalization 找不到对应的 Agent 任务。".to_string());
    }

    let source_document_ids = sources
        .iter()
        .filter_map(|source| source.get("documentId").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    sqlx::query("DELETE FROM agent_patches WHERE task_id = ?")
        .bind(&task_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("DELETE FROM agent_task_sources WHERE task_id = ?")
        .bind(&task_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    if !patches.is_empty() {
        let model: String = sqlx::query_scalar("SELECT model FROM agent_tasks WHERE id = ?")
            .bind(&task_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(database_error)?;
        sqlx::query(
            "INSERT INTO agent_patch_sets (task_id, model, created_at) VALUES (?, ?, ?) \
             ON CONFLICT(task_id) DO UPDATE SET model = excluded.model, created_at = excluded.created_at",
        )
        .bind(&task_id)
        .bind(model)
        .bind(created_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    let mut targeted_blocks = HashSet::<String>::new();
    for patch in patches {
        persist_sidecar_patch(
            &mut transaction,
            patch,
            &task_id,
            &source_document_ids,
            created_at,
            &mut targeted_blocks,
        )
        .await?;
    }
    for source in sources {
        let document_id = required_finalization_string(source, "documentId")?;
        let document_title = required_finalization_string(source, "documentTitle")?;
        let block_ids = source.get("blockIds").cloned().unwrap_or_else(|| json!([]));
        sqlx::query(
            "INSERT INTO agent_task_sources (task_id, document_id, document_title, block_ids_json, created_at) \
             VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, document_id) DO UPDATE SET \
             document_title = excluded.document_title, block_ids_json = excluded.block_ids_json, created_at = excluded.created_at",
        )
        .bind(&task_id)
        .bind(document_id)
        .bind(document_title)
        .bind(block_ids.to_string())
        .bind(created_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    sqlx::query(
        "UPDATE agent_tasks SET status = ?, current_step = ?, error = NULL, completed_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(current_step)
    .bind(completed_at)
    .bind(&task_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)
}

async fn persist_sidecar_patch(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    patch: &Value,
    task_id: &str,
    source_document_ids: &HashSet<&str>,
    created_at: i64,
    targeted_blocks: &mut HashSet<String>,
) -> Result<(), String> {
    let id = required_finalization_string(patch, "patchId")?;
    let patch_task_id = required_finalization_string(patch, "taskId")?;
    if patch_task_id != task_id {
        return Err("sidecar Patch 的 taskId 不匹配。".to_string());
    }
    let operation = required_finalization_string(patch, "operation")?;
    if !matches!(
        operation.as_str(),
        "replace"
            | "insert_before"
            | "insert_after"
            | "append"
            | "create_document"
            | "create_group"
    ) {
        return Err("sidecar Patch 的 operation 无效。".to_string());
    }
    let document_id = required_finalization_string(patch, "documentId")?;
    let block_id = patch.get("blockId").and_then(Value::as_str).unwrap_or("");
    let target_block_ids = patch
        .get("targetBlockIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "sidecar Patch 缺少 targetBlockIds。".to_string())?;
    let is_creation = matches!(operation.as_str(), "create_document" | "create_group");
    if is_creation {
        if !target_block_ids.is_empty() {
            return Err("创建类 Patch 不能声明目标块。".to_string());
        }
    } else {
        if !source_document_ids.contains(document_id.as_str()) || target_block_ids.is_empty() {
            return Err("Patch 目标文档未作为本次任务来源读取。".to_string());
        }
        let block_ids = target_block_ids
            .iter()
            .map(|value| value.as_str().unwrap_or(""))
            .collect::<Vec<_>>();
        if block_ids.iter().any(|value| value.trim().is_empty()) || !block_ids.contains(&block_id) {
            return Err("Patch 目标块无效。".to_string());
        }
        if operation != "replace" && block_ids.len() != 1 {
            return Err("插入 Patch 只能使用一个稳定锚点块。".to_string());
        }
        for block in block_ids {
            let key = format!("{document_id}:{block}");
            if !targeted_blocks.insert(key) {
                return Err("多个 Patch 不能修改同一个目标块。".to_string());
            }
        }
    }
    sqlx::query(
        "INSERT INTO agent_patches (id, task_id, operation, document_id, block_id, target_block_ids_json, \
         expected_version, before_text, after_text, reason, status, created_at, updated_at, document_title, parent_document_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(task_id)
    .bind(operation)
    .bind(document_id)
    .bind(block_id)
    .bind(Value::Array(target_block_ids.clone()).to_string())
    .bind(patch.get("expectedVersion").and_then(Value::as_i64).unwrap_or(0))
    .bind(patch.get("before").and_then(Value::as_str).unwrap_or(""))
    .bind(patch.get("after").and_then(Value::as_str).unwrap_or(""))
    .bind(patch.get("reason").and_then(Value::as_str).unwrap_or(""))
    .bind(created_at)
    .bind(created_at)
    .bind(patch.get("documentTitle").and_then(Value::as_str))
    .bind(patch.get("parentDocumentId").and_then(Value::as_str))
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn required_finalization_string(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("sidecar finalization 缺少 {name}。"))
}

async fn buffer_terminal_message(
    app: &AppHandle,
    run_id: &str,
    message: &Value,
    run_request: Option<&Value>,
    recovery_context: Option<&Value>,
) -> Result<(), String> {
    validate_run_id(run_id)?;
    let projection = terminal_projection(run_id, message, run_request, recovery_context.is_some());
    let state = app.state::<AgentWorkerSupervisorState>();
    let mut terminals = state.terminal_messages.write().await;
    if terminals.contains_key(run_id) {
        return Err(format!("run_id {run_id} 已经存在唯一终态。"));
    }
    terminals.insert(
        run_id.to_string(),
        BufferedTerminal {
            message: message.clone(),
            projection,
            recovery_context: recovery_context.cloned(),
        },
    );
    Ok(())
}

async fn refresh_terminal_snapshot(app: &AppHandle) {
    let projections = {
        let state = app.state::<AgentWorkerSupervisorState>();
        let terminals = state.terminal_messages.read().await;
        sorted_terminal_projections(&terminals)
    };
    update_snapshot(app, |snapshot| snapshot.pending_terminals = projections).await;
}

fn terminal_projection(
    run_id: &str,
    message: &Value,
    run_request: Option<&Value>,
    recoverable: bool,
) -> Value {
    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("run.error");
    json!({
        "runId": run_id,
        "workItemId": run_request.and_then(|request| request.get("workItemId")).cloned().unwrap_or(Value::Null),
        "sessionId": run_request.and_then(|request| request.get("sessionId")).cloned().unwrap_or(Value::Null),
        "workflowId": run_request.and_then(|request| request.get("workflowId")).cloned().unwrap_or(Value::Null),
        "objective": run_request.and_then(|request| request.get("objective")).cloned().unwrap_or(Value::Null),
        "intent": run_request.and_then(|request| request.get("intent")).cloned().unwrap_or(Value::Null),
        "terminalType": message_type,
        "recoverable": recoverable,
    })
}

fn sorted_terminal_projections(terminals: &HashMap<String, BufferedTerminal>) -> Vec<Value> {
    let mut values = terminals
        .values()
        .map(|terminal| terminal.projection.clone())
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.get("runId")
            .and_then(Value::as_str)
            .cmp(&right.get("runId").and_then(Value::as_str))
    });
    values
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.trim().is_empty() {
        Err("run_id 不能为空。".to_string())
    } else {
        Ok(())
    }
}

fn run_id_from_request(request: &Value) -> Result<String, String> {
    request
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "AgentRunRequest 缺少 runId。".to_string())
}

#[cfg(test)]
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

fn sorted_active_runs(run_requests: &HashMap<String, Value>) -> Vec<Value> {
    let mut values = run_requests
        .iter()
        .map(|(run_id, request)| {
            json!({
                "runId": run_id,
                "workItemId": request.get("workItemId").cloned().unwrap_or(Value::Null),
                "sessionId": request.get("sessionId").cloned().unwrap_or(Value::Null),
                "workflowId": request.get("workflowId").cloned().unwrap_or(Value::Null),
                "objective": request.get("objective").cloned().unwrap_or(Value::Null),
                "intent": request.get("intent").cloned().unwrap_or(Value::Null)
            })
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.get("runId")
            .and_then(Value::as_str)
            .cmp(&right.get("runId").and_then(Value::as_str))
    });
    values
}

fn sorted_pending_authorizations(pending: &HashMap<String, PendingAuthorization>) -> Vec<Value> {
    let mut values = pending
        .values()
        .map(|pending| pending.request.clone())
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.get("authorizationId")
            .and_then(Value::as_str)
            .cmp(&right.get("authorizationId").and_then(Value::as_str))
    });
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
        let mut headers = HashMap::from([
            (
                "Authorization".to_string(),
                "Bearer worker-placeholder".to_string(),
            ),
            ("x-api-key".to_string(), "worker-placeholder".to_string()),
        ]);
        inject_provider_credential(&mut headers, "anthropic", "secret".to_string());
        assert_eq!(headers.get("x-api-key").map(String::as_str), Some("secret"));
        assert!(!headers.contains_key("Authorization"));
        let active = sorted_active_runs(&HashMap::from([(
            "run-1".to_string(),
            json!({
                "workItemId": "task-1",
                "sessionId": "conversation-1",
                "objective": "Review",
                "intent": "review",
                "compiledContext": "must not enter the status snapshot"
            }),
        )]));
        assert_eq!(
            active[0].get("sessionId").and_then(Value::as_str),
            Some("conversation-1")
        );
        assert!(active[0].get("compiledContext").is_none());
        let terminal_message = json!({
            "version": 1,
            "type": "run.result",
            "requestId": "request-1",
            "result": { "runId": "run-1", "output": "sensitive result" }
        });
        let projection = terminal_projection("run-1", &terminal_message, Some(&request), true);
        assert_eq!(
            projection.get("terminalType").and_then(Value::as_str),
            Some("run.result")
        );
        assert!(projection.get("compiledContext").is_none());
        assert!(projection.get("output").is_none());
        let terminals = HashMap::from([(
            "run-1".to_string(),
            BufferedTerminal {
                message: terminal_message,
                projection,
                recovery_context: Some(json!({ "version": 1 })),
            },
        )]);
        assert_eq!(sorted_terminal_projections(&terminals).len(), 1);
    }

    #[tokio::test]
    async fn persists_sidecar_prepared_task_and_context_bundle_together() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-sidecar-prepared-{}-{}.db",
            std::process::id(),
            now_millis()
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
             VALUES ('doc-1', 'Document', '{\"type\":\"doc\",\"content\":[]}', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("document");
        let task = json!({
            "id": "task-1",
            "runId": "run-1",
            "workflowId": null,
            "sessionId": "session-1",
            "documentId": "doc-1",
            "projectId": "project-1",
            "conversationId": "conversation-1",
            "userInstruction": "Review document",
            "contextScope": "current_document",
            "model": "test-model",
            "currentStep": "侧车正在准备 Agent 任务",
            "createdAt": 7,
            "correlationId": "correlation-1",
            "causationId": null,
            "provider": "openai",
            "executionPolicy": {
                "version": 1,
                "maxToolRounds": 2,
                "maxDurationMs": 1000,
                "maxToolFailures": 1,
                "tokenBudget": 100,
                "allowedTools": ["get_current_document"],
                "riskLevel": "read_only",
                "allowUserInput": true,
                "allowWriteProposals": false,
                "maxRetries": 0
            }
        });
        let request = json!({
            "runId": "run-1",
            "contextBundle": {
                "id": "bundle-1",
                "taskId": "task-1",
                "version": 2,
                "scope": { "documentId": "doc-1" },
                "permissionSnapshot": { "actor": "local_user", "canReadKnowledge": true, "canProposeWrites": false },
                "sources": [],
                "activeRules": [],
                "decisions": [],
                "conflicts": [],
                "compiler": { "version": 1 },
                "snapshotHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "correlationId": "correlation-1",
                "causationId": null,
                "createdAt": 7
            }
        });
        persist_sidecar_prepared_run_in_pool(pool.as_ref(), &task, &request)
            .await
            .expect("persist prepared run");
        let row: (String, String, String) = sqlx::query_as(
            "SELECT status, context_bundle_id, run_id FROM agent_tasks WHERE id = 'task-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("task row");
        assert_eq!(
            row,
            (
                "running".to_string(),
                "bundle-1".to_string(),
                "run-1".to_string()
            )
        );
        let bundle_run_id: String =
            sqlx::query_scalar("SELECT run_id FROM context_bundles WHERE id = 'bundle-1'")
                .fetch_one(pool.as_ref())
                .await
                .expect("bundle row");
        assert_eq!(bundle_run_id, "run-1");
        drop(pool);
        crate::database::close_pool(&path)
            .await
            .expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn projects_bounded_mind_map_subtrees_with_optional_fields() {
        let content = json!({
            "rootNodeId": "root",
            "nodes": {
                "root": { "id": "root", "parentId": null, "order": 0, "text": "Root", "note": "", "sourceRefs": [] },
                "child": { "id": "child", "parentId": "root", "order": 0, "text": "Child", "note": "Details", "sourceRefs": [{ "type": "document_block", "revision": 1 }] },
                "grandchild": { "id": "grandchild", "parentId": "child", "order": 0, "text": "Grandchild", "note": "", "sourceRefs": [] }
            }
        });
        let projected = project_mind_map_subtree(
            "map-1",
            "Map",
            3,
            &content,
            &json!({ "depth": 1, "includeNotes": true, "includeSources": true }),
        )
        .expect("project subtree");
        assert_eq!(
            projected.get("returnedNodes").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            projected.get("truncated").and_then(Value::as_bool),
            Some(true)
        );
        let child = &projected["root"]["children"][0];
        assert_eq!(child.get("note").and_then(Value::as_str), Some("Details"));
        assert!(child.get("sourceRefs").and_then(Value::as_array).is_some());
    }

    #[tokio::test]
    async fn worker_dispatcher_reads_mind_maps_and_creates_disabled_automation_drafts() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-agent-worker-tools-{}-{}.db",
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
             VALUES ('doc-1', 'Doc', '{\"type\":\"doc\",\"content\":[]}', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("document");
        let content = json!({
            "schemaVersion": 1,
            "rootNodeId": "root",
            "direction": "both",
            "nodes": {
                "root": { "id": "root", "parentId": null, "order": 0, "text": "Root", "note": "", "collapsed": false, "sourceRefs": [], "metadata": {}, "style": {} },
                "child": { "id": "child", "parentId": "root", "order": 0, "text": "Child", "note": "", "collapsed": false, "sourceRefs": [], "metadata": {}, "style": {} }
            },
            "links": []
        });
        sqlx::query(
            "INSERT INTO mind_maps (id, parent_id, sort_order, title, content_json, schema_version, \
             version, last_actor_type, created_at, updated_at) \
             VALUES ('map-1', NULL, 0, 'Map', ?, 1, 1, 'user', 2, 2)",
        )
        .bind(serde_json::to_string(&content).unwrap())
        .execute(pool.as_ref())
        .await
        .expect("mind map");

        let listed = list_mind_maps_in_pool(pool.as_ref())
            .await
            .expect("list maps");
        assert_eq!(listed[0].get("id").and_then(Value::as_str), Some("map-1"));
        assert_eq!(listed[0].get("nodeCount").and_then(Value::as_u64), Some(2));
        let read = read_mind_map_in_pool(
            pool.as_ref(),
            &json!({ "mindMapId": "map-1", "depth": 0, "maxNodes": 10 }),
        )
        .await
        .expect("read map");
        assert_eq!(read.get("returnedNodes").and_then(Value::as_u64), Some(1));
        assert_eq!(read.get("truncated").and_then(Value::as_bool), Some(true));

        let request = json!({ "contextBundle": { "scope": { "documentId": "doc-1" } } });
        let draft = create_automation_draft_in_pool(
            pool.as_ref(),
            &json!({
                "name": "Daily review",
                "instruction": "Review the document",
                "triggerType": "daily",
                "dailyTime": "09:30"
            }),
            Some(&request),
        )
        .await
        .expect("automation draft");
        assert_eq!(draft.get("enabled").and_then(Value::as_bool), Some(false));
        let stored: (i64, String, String) = sqlx::query_as(
            "SELECT enabled, document_id, trigger_config_json FROM automation_tasks WHERE id = ?",
        )
        .bind(draft.get("id").and_then(Value::as_str).unwrap())
        .fetch_one(pool.as_ref())
        .await
        .expect("stored draft");
        assert_eq!(stored.0, 0);
        assert_eq!(stored.1, "doc-1");
        assert_eq!(stored.2, r#"{"dailyTime":"09:30"}"#);

        drop(pool);
        crate::database::close_pool(&path)
            .await
            .expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
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
