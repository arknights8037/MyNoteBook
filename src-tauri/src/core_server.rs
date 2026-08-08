use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{aead::OsRng, Aes256Gcm, KeyInit};
use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
};

pub const CORE_PROTOCOL_MAJOR: u16 = 1;
pub const CORE_PROTOCOL_MINOR: u16 = 5;
pub const CORE_ENDPOINT_FILENAME: &str = "endpoint-v1.json";
const CORE_LOCK_FILENAME: &str = "instance-v1.lock";
const HEADLESS_CORE_FLAG: &str = "--mynotebook-headless-core";
const ENDPOINT_DIRECTORY_FLAG: &str = "--endpoint-directory";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreEndpointDescriptor {
    pub instance_id: String,
    pub address: String,
    pub credential: String,
    pub process_id: u32,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub app_version: String,
    pub started_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreHealth {
    pub role: String,
    pub instance_id: String,
    pub process_id: u32,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub app_version: String,
    pub started_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeRequest {
    client_name: String,
    app_version: String,
    protocol_major: u16,
    protocol_minor: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeResponse {
    accepted: bool,
    reason: Option<String>,
    core: CoreHealth,
    negotiated_minor: Option<u16>,
}

struct CoreServerState {
    endpoint: CoreEndpointDescriptor,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    timers: crate::workflow_timers::CoreDurableTimerState,
    workflow_scanner: crate::workflow_runtime::CoreWorkflowScannerState,
    outbox: crate::outbox_dispatcher::CoreOutboxDispatcherState,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabasePrepareRequest {
    directory: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseQueryRequest {
    directory: String,
    query: String,
    values: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseMutationRequest {
    directory: String,
    mutation: crate::database_mutations::DatabaseMutation,
    values: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreRuntimeQuiesceResponse {
    pub(crate) timer_was_running: bool,
    pub(crate) workflow_scanner_was_running: bool,
    pub(crate) outbox_was_running: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreRuntimeResumeRequest {
    directory: String,
    timer_should_run: bool,
    workflow_scanner_should_run: bool,
    outbox_should_run: bool,
}

pub fn is_headless_core_process() -> bool {
    std::env::args().any(|argument| argument == HEADLESS_CORE_FLAG)
}

pub async fn run_from_process_args() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let endpoint_directory = flag_value(&arguments, ENDPOINT_DIRECTORY_FLAG)
        .map(PathBuf::from)
        .ok_or_else(|| "Headless Core 缺少 endpoint directory。".to_string())?;
    run_headless_core(&endpoint_directory).await
}

pub(crate) fn headless_core_arguments(endpoint_directory: &Path) -> Vec<String> {
    vec![
        HEADLESS_CORE_FLAG.to_string(),
        ENDPOINT_DIRECTORY_FLAG.to_string(),
        endpoint_directory.to_string_lossy().into_owned(),
    ]
}

pub(crate) fn endpoint_path(endpoint_directory: &Path) -> PathBuf {
    endpoint_directory.join(CORE_ENDPOINT_FILENAME)
}

pub(crate) fn read_endpoint(endpoint_directory: &Path) -> Result<CoreEndpointDescriptor, String> {
    let content = fs::read_to_string(endpoint_path(endpoint_directory))
        .map_err(|error| format!("读取 Headless Core endpoint 失败：{error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Headless Core endpoint 格式无效：{error}"))
}

pub(crate) async fn probe_endpoint(
    endpoint: &CoreEndpointDescriptor,
) -> Result<CoreHealth, String> {
    if endpoint.protocol_major != CORE_PROTOCOL_MAJOR {
        return Err(format!(
            "Headless Core 协议主版本不兼容：{} != {}",
            endpoint.protocol_major, CORE_PROTOCOL_MAJOR
        ));
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_millis(750))
        .build()
        .map_err(|error| format!("创建 Headless Core client 失败：{error}"))?
        .get(format!("http://{}/v1/health", endpoint.address))
        .bearer_auth(&endpoint.credential)
        .send()
        .await
        .map_err(|error| format!("连接 Headless Core 失败：{error}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Headless Core 拒绝健康检查：{}", response.status()));
    }
    let health = response
        .json::<CoreHealth>()
        .await
        .map_err(|error| format!("解析 Headless Core 健康状态失败：{error}"))?;
    if health.instance_id != endpoint.instance_id || health.process_id != endpoint.process_id {
        return Err("Headless Core endpoint 身份与活动进程不一致。".to_string());
    }
    Ok(health)
}

pub(crate) async fn negotiate_endpoint(
    endpoint: &CoreEndpointDescriptor,
    client_name: &str,
) -> Result<CoreHealth, String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_millis(750))
        .build()
        .map_err(|error| format!("创建 Headless Core client 失败：{error}"))?
        .post(format!("http://{}/v1/handshake", endpoint.address))
        .bearer_auth(&endpoint.credential)
        .json(&HandshakeRequest {
            client_name: client_name.to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_major: CORE_PROTOCOL_MAJOR,
            protocol_minor: CORE_PROTOCOL_MINOR,
        })
        .send()
        .await
        .map_err(|error| format!("Headless Core 协商失败：{error}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Headless Core 拒绝协议协商：{}", response.status()));
    }
    let handshake = response
        .json::<HandshakeResponse>()
        .await
        .map_err(|error| format!("解析 Headless Core 协商结果失败：{error}"))?;
    if !handshake.accepted {
        return Err(handshake
            .reason
            .unwrap_or_else(|| "Headless Core 协议不兼容。".to_string()));
    }
    if handshake.core.instance_id != endpoint.instance_id {
        return Err("Headless Core 协商身份与 endpoint 不一致。".to_string());
    }
    Ok(handshake.core)
}

pub(crate) async fn prepare_database(
    endpoint: &CoreEndpointDescriptor,
    directory: &Path,
) -> Result<crate::database::DatabasePreparation, String> {
    post_authenticated(
        endpoint,
        "/v1/database/prepare",
        &DatabasePrepareRequest {
            directory: directory.to_string_lossy().into_owned(),
        },
    )
    .await
}

pub(crate) async fn execute_database_query(
    endpoint: &CoreEndpointDescriptor,
    directory: &Path,
    query: String,
    values: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    post_authenticated(
        endpoint,
        "/v1/database/query",
        &DatabaseQueryRequest {
            directory: directory.to_string_lossy().into_owned(),
            query,
            values,
        },
    )
    .await
}

pub(crate) async fn execute_database_mutation(
    endpoint: &CoreEndpointDescriptor,
    directory: &Path,
    mutation: crate::database_mutations::DatabaseMutation,
    values: Vec<Value>,
) -> Result<crate::database_mutations::ExecuteDatabaseMutationResult, String> {
    post_authenticated(
        endpoint,
        "/v1/database/mutation",
        &DatabaseMutationRequest {
            directory: directory.to_string_lossy().into_owned(),
            mutation,
            values,
        },
    )
    .await
}

pub(crate) async fn close_database_read_pool(
    endpoint: &CoreEndpointDescriptor,
    directory: &Path,
) -> Result<bool, String> {
    post_authenticated(
        endpoint,
        "/v1/database/close-read-pool",
        &DatabasePrepareRequest {
            directory: directory.to_string_lossy().into_owned(),
        },
    )
    .await
}

pub(crate) async fn close_database_pool(
    endpoint: &CoreEndpointDescriptor,
    directory: &Path,
) -> Result<(), String> {
    post_authenticated::<_, bool>(
        endpoint,
        "/v1/database/close-pool",
        &DatabasePrepareRequest {
            directory: directory.to_string_lossy().into_owned(),
        },
    )
    .await
    .map(|_| ())
}

pub(crate) async fn get_workflow_timer_snapshot(
    endpoint: &CoreEndpointDescriptor,
) -> Result<crate::workflow_timers::DurableTimerSnapshot, String> {
    post_authenticated(endpoint, "/v1/timer/snapshot", &()).await
}

pub(crate) async fn get_workflow_scanner_snapshot(
    endpoint: &CoreEndpointDescriptor,
) -> Result<crate::workflow_runtime::WorkflowScannerSnapshot, String> {
    post_authenticated(endpoint, "/v1/workflow/snapshot", &()).await
}

pub(crate) async fn get_outbox_dispatcher_snapshot(
    endpoint: &CoreEndpointDescriptor,
) -> Result<crate::outbox_dispatcher::OutboxDispatcherSnapshot, String> {
    post_authenticated(endpoint, "/v1/outbox/snapshot", &()).await
}

pub(crate) async fn quiesce_background_runtime(
    endpoint: &CoreEndpointDescriptor,
) -> Result<CoreRuntimeQuiesceResponse, String> {
    post_authenticated(endpoint, "/v1/runtime/quiesce", &()).await
}

pub(crate) async fn resume_background_runtime(
    endpoint: &CoreEndpointDescriptor,
    directory: &Path,
    snapshot: &CoreRuntimeQuiesceResponse,
) -> Result<(), String> {
    post_authenticated::<_, bool>(
        endpoint,
        "/v1/runtime/resume",
        &CoreRuntimeResumeRequest {
            directory: directory.to_string_lossy().into_owned(),
            timer_should_run: snapshot.timer_was_running,
            workflow_scanner_should_run: snapshot.workflow_scanner_was_running,
            outbox_should_run: snapshot.outbox_was_running,
        },
    )
    .await
    .map(|_| ())
}

pub(crate) async fn shutdown_endpoint(endpoint: &CoreEndpointDescriptor) -> Result<(), String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("创建 Headless Core client 失败：{error}"))?
        .post(format!("http://{}/v1/shutdown", endpoint.address))
        .bearer_auth(&endpoint.credential)
        .send()
        .await
        .map_err(|error| format!("关闭不兼容 Headless Core 失败：{error}"))?;
    if response.status() != reqwest::StatusCode::ACCEPTED {
        return Err(format!("Headless Core 拒绝维护关闭：{}", response.status()));
    }
    Ok(())
}

async fn post_authenticated<Request, Response>(
    endpoint: &CoreEndpointDescriptor,
    path: &str,
    request: &Request,
) -> Result<Response, String>
where
    Request: Serialize + ?Sized,
    Response: DeserializeOwned,
{
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(5 * 60))
        .build()
        .map_err(|error| format!("创建 Headless Core client 失败：{error}"))?
        .post(format!("http://{}{}", endpoint.address, path))
        .bearer_auth(&endpoint.credential)
        .json(request)
        .send()
        .await
        .map_err(|error| format!("调用 Headless Core 失败：{error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response.text().await.unwrap_or_default();
        return Err(format!("Headless Core {path} 返回 {status}：{message}"));
    }
    response
        .json::<Response>()
        .await
        .map_err(|error| format!("解析 Headless Core {path} 响应失败：{error}"))
}

async fn run_headless_core(endpoint_directory: &Path) -> Result<(), String> {
    fs::create_dir_all(endpoint_directory)
        .map_err(|error| format!("创建 Headless Core 目录失败：{error}"))?;
    if let Ok(endpoint) = read_endpoint(endpoint_directory) {
        if probe_endpoint(&endpoint).await.is_ok() {
            return Ok(());
        }
    }
    let lock_path = endpoint_directory.join(CORE_LOCK_FILENAME);
    let lock = acquire_instance_lock(&lock_path, endpoint_directory).await?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("绑定 Headless Core loopback 端口失败：{error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("读取 Headless Core 地址失败：{error}"))?;
    let credential = generate_credential();
    let instance_id = credential_fingerprint(&credential);
    let endpoint = CoreEndpointDescriptor {
        instance_id,
        address: address.to_string(),
        credential,
        process_id: std::process::id(),
        protocol_major: CORE_PROTOCOL_MAJOR,
        protocol_minor: CORE_PROTOCOL_MINOR,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: now_millis(),
    };
    write_endpoint(endpoint_directory, &endpoint)?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (event_bus, _) = broadcast::channel(256);
    let state = Arc::new(CoreServerState {
        endpoint: endpoint.clone(),
        shutdown: Mutex::new(Some(shutdown_tx)),
        timers: crate::workflow_timers::CoreDurableTimerState::default(),
        workflow_scanner: crate::workflow_runtime::CoreWorkflowScannerState::new(event_bus.clone()),
        outbox: crate::outbox_dispatcher::CoreOutboxDispatcherState::new(event_bus),
    });
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/handshake", post(handshake))
        .route("/v1/shutdown", post(shutdown))
        .route("/v1/database/prepare", post(database_prepare))
        .route("/v1/database/query", post(database_query))
        .route("/v1/database/mutation", post(database_mutation))
        .route(
            "/v1/database/close-read-pool",
            post(database_close_read_pool),
        )
        .route("/v1/database/close-pool", post(database_close_pool))
        .route("/v1/timer/snapshot", post(timer_snapshot))
        .route("/v1/workflow/snapshot", post(workflow_snapshot))
        .route("/v1/outbox/snapshot", post(outbox_snapshot))
        .route("/v1/runtime/quiesce", post(runtime_quiesce))
        .route("/v1/runtime/resume", post(runtime_resume))
        .with_state(Arc::clone(&state));
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|error| format!("Headless Core server 异常退出：{error}"));
    state.outbox.shutdown().await;
    state.workflow_scanner.shutdown().await;
    state.timers.shutdown().await;
    cleanup_endpoint(endpoint_directory, &endpoint);
    drop(lock);
    let _ = fs::remove_file(lock_path);
    result
}

async fn health(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
) -> Result<Json<CoreHealth>, StatusCode> {
    authorize(&headers, &state.endpoint.credential)?;
    Ok(Json(core_health(&state.endpoint)))
}

async fn handshake(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<HandshakeRequest>,
) -> Result<Json<HandshakeResponse>, StatusCode> {
    authorize(&headers, &state.endpoint.credential)?;
    let accepted = request.protocol_major == CORE_PROTOCOL_MAJOR
        && request.protocol_minor <= CORE_PROTOCOL_MINOR;
    let reason = (!accepted).then(|| {
        format!(
            "{} {} 要求协议 {}.{}，Core 当前为 {}.{}",
            request.client_name,
            request.app_version,
            request.protocol_major,
            request.protocol_minor,
            CORE_PROTOCOL_MAJOR,
            CORE_PROTOCOL_MINOR
        )
    });
    Ok(Json(HandshakeResponse {
        accepted,
        reason,
        core: core_health(&state.endpoint),
        negotiated_minor: accepted.then(|| request.protocol_minor.min(CORE_PROTOCOL_MINOR)),
    }))
}

async fn shutdown(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    authorize(&headers, &state.endpoint.credential)?;
    if let Some(sender) = state
        .shutdown
        .lock()
        .map_err(|_| StatusCode::CONFLICT)?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(StatusCode::ACCEPTED)
}

async fn database_prepare(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<DatabasePrepareRequest>,
) -> Result<Json<crate::database::DatabasePreparation>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let directory = normalize_database_directory(&request.directory)?;
    let preparation =
        crate::database::prepare_database_path(&directory, &crate::database::DATABASE_MIGRATOR)
            .await
            .map_err(internal_api_error)?;
    state
        .timers
        .ensure_for_directory(&directory)
        .await
        .map_err(internal_api_error)?;
    if let Err(error) = state
        .workflow_scanner
        .ensure_for_directory(&directory)
        .await
    {
        state.timers.quiesce().await;
        return Err(internal_api_error(error));
    }
    if let Err(error) = state.outbox.ensure_for_directory(&directory).await {
        state.workflow_scanner.quiesce().await;
        state.timers.quiesce().await;
        return Err(internal_api_error(error));
    }
    Ok(Json(preparation))
}

async fn database_query(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<DatabaseQueryRequest>,
) -> Result<Json<Vec<Map<String, Value>>>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let directory = normalize_database_directory(&request.directory)?;
    let pool = crate::database::get_read_only_pool_for_path(
        &directory.join(crate::database::DATABASE_FILENAME),
    )
    .await
    .map_err(internal_api_error)?;
    crate::database_queries::execute_database_query_in_pool(
        pool.as_ref(),
        &request.query,
        request.values,
    )
    .await
    .map(Json)
    .map_err(internal_api_error)
}

async fn database_mutation(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<DatabaseMutationRequest>,
) -> Result<Json<crate::database_mutations::ExecuteDatabaseMutationResult>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let directory = normalize_database_directory(&request.directory)?;
    let pool = crate::database::get_pool_for_path(
        &directory.join(crate::database::DATABASE_FILENAME),
        false,
    )
    .await
    .map_err(internal_api_error)?;
    crate::database_mutations::execute_database_mutation_in_pool(
        pool.as_ref(),
        request.mutation,
        request.values,
    )
    .await
    .map(Json)
    .map_err(internal_api_error)
}

async fn database_close_read_pool(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<DatabasePrepareRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let directory = normalize_database_directory(&request.directory)?;
    Ok(Json(
        crate::database::close_read_only_pool(&directory.join(crate::database::DATABASE_FILENAME))
            .await,
    ))
}

async fn database_close_pool(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<DatabasePrepareRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let directory = normalize_database_directory(&request.directory)?;
    state.outbox.quiesce_if_directory(&directory).await;
    state.timers.quiesce_if_directory(&directory).await;
    state
        .workflow_scanner
        .quiesce_if_directory(&directory)
        .await;
    crate::database::close_pool(&directory.join(crate::database::DATABASE_FILENAME))
        .await
        .map_err(internal_api_error)?;
    Ok(Json(true))
}

async fn timer_snapshot(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
) -> Result<Json<crate::workflow_timers::DurableTimerSnapshot>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    Ok(Json(state.timers.snapshot().await))
}

async fn workflow_snapshot(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
) -> Result<Json<crate::workflow_runtime::WorkflowScannerSnapshot>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    Ok(Json(state.workflow_scanner.snapshot().await))
}

async fn outbox_snapshot(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
) -> Result<Json<crate::outbox_dispatcher::OutboxDispatcherSnapshot>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    Ok(Json(state.outbox.snapshot().await))
}

async fn runtime_quiesce(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
) -> Result<Json<CoreRuntimeQuiesceResponse>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let outbox = state.outbox.quiesce().await;
    let timer = state.timers.quiesce().await;
    let workflow = state.workflow_scanner.quiesce().await;
    Ok(Json(CoreRuntimeQuiesceResponse {
        timer_was_running: timer.was_running,
        workflow_scanner_was_running: workflow.was_running,
        outbox_was_running: outbox.was_running,
    }))
}

async fn runtime_resume(
    State(state): State<Arc<CoreServerState>>,
    headers: HeaderMap,
    Json(request): Json<CoreRuntimeResumeRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    authorize_api(&headers, &state.endpoint.credential)?;
    let directory = normalize_database_directory(&request.directory)?;
    let mut timer_started = false;
    let mut workflow_started = false;
    if request.timer_should_run {
        state
            .timers
            .ensure_for_directory(&directory)
            .await
            .map_err(internal_api_error)?;
        timer_started = true;
    }
    if request.workflow_scanner_should_run {
        if let Err(error) = state
            .workflow_scanner
            .ensure_for_directory(&directory)
            .await
        {
            if timer_started {
                state.timers.quiesce().await;
            }
            return Err(internal_api_error(error));
        }
        workflow_started = true;
    }
    if request.outbox_should_run {
        if let Err(error) = state.outbox.ensure_for_directory(&directory).await {
            if workflow_started {
                state.workflow_scanner.quiesce().await;
            }
            if timer_started {
                state.timers.quiesce().await;
            }
            return Err(internal_api_error(error));
        }
    }
    Ok(Json(true))
}

fn authorize_api(headers: &HeaderMap, credential: &str) -> Result<(), (StatusCode, String)> {
    authorize(headers, credential).map_err(|status| (status, "unauthorized".to_string()))
}

fn normalize_database_directory(value: &str) -> Result<PathBuf, (StatusCode, String)> {
    let directory = PathBuf::from(value);
    if value.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "数据库目录不能为空。".to_string()));
    }
    if directory.is_absolute() {
        Ok(directory)
    } else {
        std::env::current_dir()
            .map(|current| current.join(directory))
            .map_err(|error| internal_api_error(format!("解析数据库目录失败：{error}")))
    }
}

fn internal_api_error(error: String) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error)
}

fn authorize(headers: &HeaderMap, credential: &str) -> Result<(), StatusCode> {
    let supplied = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let expected = Sha256::digest(credential.as_bytes());
    let actual = Sha256::digest(supplied.as_bytes());
    if bool::from(expected.as_slice().ct_eq(actual.as_slice())) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn core_health(endpoint: &CoreEndpointDescriptor) -> CoreHealth {
    CoreHealth {
        role: "headless_core".to_string(),
        instance_id: endpoint.instance_id.clone(),
        process_id: endpoint.process_id,
        protocol_major: endpoint.protocol_major,
        protocol_minor: endpoint.protocol_minor,
        app_version: endpoint.app_version.clone(),
        started_at: endpoint.started_at,
    }
}

async fn acquire_instance_lock(
    lock_path: &Path,
    endpoint_directory: &Path,
) -> Result<fs::File, String> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
    {
        Ok(mut file) => {
            writeln!(file, "{}", std::process::id())
                .map_err(|error| format!("写入 Headless Core lock 失败：{error}"))?;
            Ok(file)
        }
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Ok(endpoint) = read_endpoint(endpoint_directory) {
                if probe_endpoint(&endpoint).await.is_ok() {
                    return Err("Headless Core 已由另一个进程启动。".to_string());
                }
            }
            fs::remove_file(lock_path)
                .map_err(|error| format!("清理失效 Headless Core lock 失败：{error}"))?;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(lock_path)
                .map_err(|error| format!("获取 Headless Core lock 失败：{error}"))
        }
    }
}

fn write_endpoint(
    endpoint_directory: &Path,
    endpoint: &CoreEndpointDescriptor,
) -> Result<(), String> {
    let temporary = endpoint_directory.join(format!(".{CORE_ENDPOINT_FILENAME}.tmp"));
    let serialized = serde_json::to_vec(endpoint)
        .map_err(|error| format!("序列化 Headless Core endpoint 失败：{error}"))?;
    write_private_file(&temporary, &serialized)?;
    let destination = endpoint_path(endpoint_directory);
    if let Err(first_error) = fs::rename(&temporary, &destination) {
        if destination.exists() {
            fs::remove_file(&destination)
                .map_err(|error| format!("清理失效 Headless Core endpoint 失败：{error}"))?;
            fs::rename(&temporary, &destination)
                .map_err(|error| format!("发布 Headless Core endpoint 失败：{error}"))?;
        } else {
            return Err(format!("发布 Headless Core endpoint 失败：{first_error}"));
        }
    }
    Ok(())
}

fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("写入 Headless Core endpoint 失败：{error}"))?;
    file.write_all(content)
        .map_err(|error| format!("写入 Headless Core endpoint 失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步 Headless Core endpoint 失败：{error}"))
}

fn cleanup_endpoint(endpoint_directory: &Path, endpoint: &CoreEndpointDescriptor) {
    if read_endpoint(endpoint_directory)
        .ok()
        .is_some_and(|current| current.instance_id == endpoint.instance_id)
    {
        let _ = fs::remove_file(endpoint_path(endpoint_directory));
    }
}

fn generate_credential() -> String {
    let key = Aes256Gcm::generate_key(&mut OsRng);
    URL_SAFE_NO_PAD.encode(key)
}

fn credential_fingerprint(credential: &str) -> String {
    let digest = Sha256::digest(credential.as_bytes());
    format!("core-{}", URL_SAFE_NO_PAD.encode(&digest[..12]))
}

fn flag_value(arguments: &[String], name: &str) -> Option<String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .cloned()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_random_and_descriptors_never_share_identity() {
        let first = generate_credential();
        let second = generate_credential();
        assert_ne!(first, second);
        assert_ne!(
            credential_fingerprint(&first),
            credential_fingerprint(&second)
        );
        assert!(first.len() >= 40);
    }

    #[test]
    fn process_arguments_require_an_explicit_endpoint_directory() {
        let arguments = vec![
            "my-notebook".to_string(),
            HEADLESS_CORE_FLAG.to_string(),
            ENDPOINT_DIRECTORY_FLAG.to_string(),
            "C:/example/core".to_string(),
        ];
        assert_eq!(
            flag_value(&arguments, ENDPOINT_DIRECTORY_FLAG).as_deref(),
            Some("C:/example/core")
        );
    }

    #[tokio::test]
    async fn loopback_server_requires_credentials_and_negotiates_protocol() {
        let directory = std::env::temp_dir().join(format!(
            "my-notebook-headless-core-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&directory).expect("create stale endpoint directory");
        fs::write(endpoint_path(&directory), b"{\"stale\":true}").expect("write stale endpoint");
        let server_directory = directory.clone();
        let server = tokio::spawn(async move { run_headless_core(&server_directory).await });
        let endpoint = loop {
            if let Ok(endpoint) = read_endpoint(&directory) {
                break endpoint;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let unauthorized = reqwest::Client::new()
            .get(format!("http://{}/v1/health", endpoint.address))
            .send()
            .await
            .expect("unauthorized health request");
        assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
        let health = negotiate_endpoint(&endpoint, "core-server-test")
            .await
            .expect("negotiate compatible protocol");
        assert_eq!(health.role, "headless_core");
        let database_directory = directory.join("data");
        let preparation = prepare_database(&endpoint, &database_directory)
            .await
            .expect("prepare database through Core");
        assert!(Path::new(&preparation.database_path).is_file());
        let rows = execute_database_query(
            &endpoint,
            &database_directory,
            "SELECT COUNT(*) AS count FROM _sqlx_migrations".to_string(),
            Vec::new(),
        )
        .await
        .expect("query database through Core");
        assert!(rows[0].get("count").and_then(Value::as_i64).unwrap_or(0) > 0);
        let timer_now = now_millis();
        let pool = crate::database::get_pool_for_path(
            &database_directory.join(crate::database::DATABASE_FILENAME),
            false,
        )
        .await
        .expect("open prepared timer database");
        sqlx::query(
            "INSERT INTO workflow_wait_conditions (id, workflow_id, deduplication_key, \
             condition_kind, status, correlation_id, payload_json, created_at, updated_at) \
             VALUES ('core-wait', 'core-workflow', 'core-wake', 'timer', 'pending', \
             'core-correlation', '{}', ?, ?)",
        )
        .bind(timer_now)
        .bind(timer_now)
        .execute(pool.as_ref())
        .await
        .expect("insert Core timer wait");
        sqlx::query(
            "INSERT INTO workflow_timers (id, workflow_id, wait_condition_id, due_at, \
             available_at, status, attempt_count, created_at, updated_at) VALUES \
             ('core-timer', 'core-workflow', 'core-wait', ?, ?, 'scheduled', 0, ?, ?)",
        )
        .bind(timer_now)
        .bind(timer_now)
        .bind(timer_now)
        .bind(timer_now)
        .execute(pool.as_ref())
        .await
        .expect("insert due Core timer");
        let mut fired = false;
        for _ in 0..60 {
            let timer_rows = execute_database_query(
                &endpoint,
                &database_directory,
                "SELECT status FROM workflow_timers WHERE id = 'core-timer'".to_string(),
                Vec::new(),
            )
            .await
            .expect("query Core timer status");
            if timer_rows[0].get("status").and_then(Value::as_str) == Some("fired") {
                fired = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(fired, "Headless Core scheduler should fire a due timer");
        let timer_snapshot = get_workflow_timer_snapshot(&endpoint)
            .await
            .expect("read Core timer snapshot");
        let timer_snapshot =
            serde_json::to_value(timer_snapshot).expect("serialize timer snapshot");
        assert_eq!(timer_snapshot["status"], "running");
        assert!(timer_snapshot["lastSuccessAt"].as_i64().is_some());
        let workflow_now = now_millis();
        let source_payload = serde_json::json!({ "source": "core-test" });
        let mut transaction = pool.begin().await.expect("begin workflow fixture");
        crate::domain_events::record_with_outbox(
            &mut transaction,
            crate::domain_events::NewDomainEvent {
                event_id: "core-workflow-source-event",
                outbox_id: "core-workflow-source-outbox",
                event_type: "workflow.source.accepted",
                aggregate_type: "workflow",
                aggregate_id: "core-event-workflow",
                payload: &source_payload,
                actor_id: "core-test",
                source: "core_test",
                workspace_id: None,
                deduplication_key: "core-workflow-source-event",
                security_scope: None,
                correlation_id: "core-event-correlation",
                causation_id: None,
                occurred_at: workflow_now,
            },
        )
        .await
        .expect("record workflow source event");
        let workflow = crate::workflow_runtime::create_workflow_in_transaction(
            &mut transaction,
            crate::workflow_runtime::NewWorkflow {
                work_item_id: "core-event-work-item",
                workflow_id: "core-event-workflow",
                event_id: "core-workflow-source-event",
                source_type: "manual",
                classification: "core_test",
                payload: &source_payload,
                correlation_id: "core-event-correlation",
                causation_id: None,
            },
            workflow_now,
        )
        .await
        .expect("create Core workflow");
        transaction.commit().await.expect("commit workflow fixture");
        crate::workflow_runtime::start_run(
            pool.as_ref(),
            &workflow,
            "core-event-run",
            1,
            workflow_now + 1,
        )
        .await
        .expect("start Core workflow run");
        crate::workflow_runtime::suspend_run(
            pool.as_ref(),
            &workflow,
            "core-event-run",
            crate::workflow_runtime::SuspendRequest {
                condition_kind: "event",
                deduplication_key: "wait-review",
                payload: &serde_json::json!({ "eventType": "review.received" }),
                due_at: None,
            },
            workflow_now + 2,
        )
        .await
        .expect("suspend Core workflow for event");
        let review_payload = serde_json::json!({ "decision": "approved" });
        let mut transaction = pool.begin().await.expect("begin review event");
        crate::domain_events::record_with_outbox(
            &mut transaction,
            crate::domain_events::NewDomainEvent {
                event_id: "core-review-event",
                outbox_id: "core-review-outbox",
                event_type: "review.received",
                aggregate_type: "workflow",
                aggregate_id: "core-event-workflow",
                payload: &review_payload,
                actor_id: "core-test",
                source: "core_test",
                workspace_id: None,
                deduplication_key: "core-review-event",
                security_scope: None,
                correlation_id: "core-event-correlation",
                causation_id: Some("core-workflow-source-event"),
                occurred_at: workflow_now + 3,
            },
        )
        .await
        .expect("record correlated review event");
        transaction.commit().await.expect("commit review event");
        let mut workflow_resumed = false;
        for _ in 0..60 {
            let workflow_rows = execute_database_query(
                &endpoint,
                &database_directory,
                "SELECT state FROM workflow_instances WHERE id = 'core-event-workflow'".to_string(),
                Vec::new(),
            )
            .await
            .expect("query Core workflow state");
            if workflow_rows[0].get("state").and_then(Value::as_str) == Some("READY") {
                workflow_resumed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            workflow_resumed,
            "Headless Core scanner should resume a correlated event wait"
        );
        let workflow_snapshot = serde_json::to_value(
            get_workflow_scanner_snapshot(&endpoint)
                .await
                .expect("read Core workflow scanner snapshot"),
        )
        .expect("serialize workflow scanner snapshot");
        assert_eq!(workflow_snapshot["status"], "running");
        assert!(
            workflow_snapshot["resumedEventWaitCount"]
                .as_u64()
                .unwrap_or(0)
                >= 1
        );
        let mut outbox_published = false;
        for _ in 0..60 {
            let outbox_rows = execute_database_query(
                &endpoint,
                &database_directory,
                "SELECT COUNT(*) AS count FROM outbox_messages WHERE status = 'published'"
                    .to_string(),
                Vec::new(),
            )
            .await
            .expect("query Core Outbox delivery status");
            if outbox_rows[0]
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                >= 2
            {
                outbox_published = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            outbox_published,
            "Headless Core should publish durable Outbox messages"
        );
        let outbox_snapshot = serde_json::to_value(
            get_outbox_dispatcher_snapshot(&endpoint)
                .await
                .expect("read Core Outbox snapshot"),
        )
        .expect("serialize Core Outbox snapshot");
        assert_eq!(outbox_snapshot["status"], "running");
        assert!(outbox_snapshot["publishedCount"].as_u64().unwrap_or(0) >= 2);
        let runtime_migration = quiesce_background_runtime(&endpoint)
            .await
            .expect("quiesce Core background runtime");
        assert!(runtime_migration.timer_was_running);
        assert!(runtime_migration.workflow_scanner_was_running);
        assert!(runtime_migration.outbox_was_running);
        let paused_snapshot = serde_json::to_value(
            get_workflow_timer_snapshot(&endpoint)
                .await
                .expect("read paused Core timer snapshot"),
        )
        .expect("serialize paused timer snapshot");
        assert_eq!(paused_snapshot["status"], "paused");
        let paused_workflow_snapshot = serde_json::to_value(
            get_workflow_scanner_snapshot(&endpoint)
                .await
                .expect("read paused workflow scanner snapshot"),
        )
        .expect("serialize paused workflow scanner snapshot");
        assert_eq!(paused_workflow_snapshot["status"], "paused");
        let paused_outbox_snapshot = serde_json::to_value(
            get_outbox_dispatcher_snapshot(&endpoint)
                .await
                .expect("read paused Core Outbox snapshot"),
        )
        .expect("serialize paused Core Outbox snapshot");
        assert_eq!(paused_outbox_snapshot["status"], "paused");
        resume_background_runtime(&endpoint, &database_directory, &runtime_migration)
            .await
            .expect("resume Core background runtime");
        let resumed_snapshot = serde_json::to_value(
            get_workflow_timer_snapshot(&endpoint)
                .await
                .expect("read resumed Core timer snapshot"),
        )
        .expect("serialize resumed timer snapshot");
        assert_eq!(resumed_snapshot["status"], "running");
        let resumed_workflow_snapshot = serde_json::to_value(
            get_workflow_scanner_snapshot(&endpoint)
                .await
                .expect("read resumed workflow scanner snapshot"),
        )
        .expect("serialize resumed workflow scanner snapshot");
        assert_eq!(resumed_workflow_snapshot["status"], "running");
        let resumed_outbox_snapshot = serde_json::to_value(
            get_outbox_dispatcher_snapshot(&endpoint)
                .await
                .expect("read resumed Core Outbox snapshot"),
        )
        .expect("serialize resumed Core Outbox snapshot");
        assert_eq!(resumed_outbox_snapshot["status"], "running");
        let mutation = execute_database_mutation(
            &endpoint,
            &database_directory,
            crate::database_mutations::DatabaseMutation::MarkInterruptedAgentTasks,
            vec![Value::from(now_millis())],
        )
        .await
        .expect("execute catalog mutation through Core");
        assert_eq!(mutation.rows_affected, 0);
        assert!(close_database_read_pool(&endpoint, &database_directory)
            .await
            .expect("close Core read pool"));
        close_database_pool(&endpoint, &database_directory)
            .await
            .expect("close all Core database pools");
        let incompatible = reqwest::Client::new()
            .post(format!("http://{}/v1/handshake", endpoint.address))
            .bearer_auth(&endpoint.credential)
            .json(&HandshakeRequest {
                client_name: "future-client".to_string(),
                app_version: "99.0.0".to_string(),
                protocol_major: CORE_PROTOCOL_MAJOR + 1,
                protocol_minor: 0,
            })
            .send()
            .await
            .expect("incompatible handshake")
            .json::<HandshakeResponse>()
            .await
            .expect("incompatible response");
        assert!(!incompatible.accepted);
        let future_minor = reqwest::Client::new()
            .post(format!("http://{}/v1/handshake", endpoint.address))
            .bearer_auth(&endpoint.credential)
            .json(&HandshakeRequest {
                client_name: "future-minor-client".to_string(),
                app_version: "0.1.0".to_string(),
                protocol_major: CORE_PROTOCOL_MAJOR,
                protocol_minor: CORE_PROTOCOL_MINOR + 1,
            })
            .send()
            .await
            .expect("future minor handshake")
            .json::<HandshakeResponse>()
            .await
            .expect("future minor response");
        assert!(!future_minor.accepted);
        reqwest::Client::new()
            .post(format!("http://{}/v1/shutdown", endpoint.address))
            .bearer_auth(&endpoint.credential)
            .send()
            .await
            .expect("shutdown request");
        server.await.expect("server task").expect("server shutdown");
        assert!(!endpoint_path(&directory).exists());
        crate::database::close_pool(&database_directory.join(crate::database::DATABASE_FILENAME))
            .await
            .expect("close Core database pools");
        let _ = fs::remove_dir_all(directory);
    }
}
