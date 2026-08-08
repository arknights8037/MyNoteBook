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
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::oneshot};

pub const CORE_PROTOCOL_MAJOR: u16 = 1;
pub const CORE_PROTOCOL_MINOR: u16 = 0;
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
    let state = Arc::new(CoreServerState {
        endpoint: endpoint.clone(),
        shutdown: Mutex::new(Some(shutdown_tx)),
    });
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/handshake", post(handshake))
        .route("/v1/shutdown", post(shutdown))
        .with_state(state);
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|error| format!("Headless Core server 异常退出：{error}"));
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
    let accepted = request.protocol_major == CORE_PROTOCOL_MAJOR;
    let reason = (!accepted).then(|| {
        format!(
            "{} {} 使用协议 {}.{}，Core 仅支持 {}.{}",
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
        reqwest::Client::new()
            .post(format!("http://{}/v1/shutdown", endpoint.address))
            .bearer_auth(&endpoint.credential)
            .send()
            .await
            .expect("shutdown request");
        server.await.expect("server task").expect("server shutdown");
        assert!(!endpoint_path(&directory).exists());
        let _ = fs::remove_dir_all(directory);
    }
}
