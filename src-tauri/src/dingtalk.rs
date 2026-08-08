use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    sync::{Mutex, RwLock},
    task::JoinHandle,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::{
    database,
    secret_store::{self, AiSecretState},
    sensitive_data::redact_sensitive_text,
};

const CONNECTION_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const BOT_MESSAGE_TOPIC: &str = "/v1.0/im/bot/messages/get";
const SECRET_PREFIX: &str = "dingtalk";
const MAX_MESSAGE_CHARS: usize = 200_000;

#[derive(Default)]
pub struct DingTalkRuntimeState {
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CoreConnectorStatus {
    Stopped,
    Running,
    Paused,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnectorSnapshot {
    status: CoreConnectorStatus,
    active_connector_count: usize,
    received_message_count: u64,
    last_event_at: Option<i64>,
    last_error: Option<String>,
}

impl Default for CoreConnectorSnapshot {
    fn default() -> Self {
        Self {
            status: CoreConnectorStatus::Stopped,
            active_connector_count: 0,
            received_message_count: 0,
            last_event_at: None,
            last_error: None,
        }
    }
}

pub(crate) struct CoreDingTalkConnectorState {
    runtime: DingTalkRuntimeState,
    secrets: AiSecretState,
    app_local_data_directory: PathBuf,
    database_path: Mutex<Option<PathBuf>>,
    snapshot: Arc<RwLock<CoreConnectorSnapshot>>,
}

pub(crate) struct DingTalkProjectionState {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Default for DingTalkProjectionState {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub(crate) async fn get_dingtalk_connector_snapshot(
    app: AppHandle,
    core_state: State<'_, crate::core_supervisor::HeadlessCoreSupervisorState>,
) -> Result<CoreConnectorSnapshot, String> {
    let endpoint = crate::core_supervisor::active_endpoint(&app, core_state.inner()).await?;
    crate::core_server::get_connector_snapshot(&endpoint).await
}

pub(crate) async fn ensure_snapshot_projection(
    app: &AppHandle,
    state: &DingTalkProjectionState,
) -> Result<(), String> {
    let mut task = state.task.lock().await;
    if task.as_ref().is_some_and(|task| !task.is_finished()) {
        return Ok(());
    }
    if let Some(existing) = task.take() {
        existing.abort();
    }
    let app = app.clone();
    *task = Some(tokio::spawn(async move {
        let mut last_received_count = 0_u64;
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let core_state = app.state::<crate::core_supervisor::HeadlessCoreSupervisorState>();
            let Ok(endpoint) =
                crate::core_supervisor::active_endpoint(&app, core_state.inner()).await
            else {
                continue;
            };
            let Ok(snapshot) = crate::core_server::get_connector_snapshot(&endpoint).await else {
                continue;
            };
            if snapshot.received_message_count > last_received_count {
                let _ = app.emit(
                    "dingtalk-message-received",
                    json!({
                        "receivedMessageCount": snapshot.received_message_count,
                        "lastEventAt": snapshot.last_event_at,
                    }),
                );
            }
            last_received_count = snapshot.received_message_count;
        }
    }));
    Ok(())
}

pub(crate) struct CoreConnectorMigrationSnapshot {
    pub(crate) was_running: bool,
}

impl CoreDingTalkConnectorState {
    pub(crate) fn new(app_local_data_directory: PathBuf) -> Self {
        Self {
            runtime: DingTalkRuntimeState::default(),
            secrets: AiSecretState::default(),
            app_local_data_directory,
            database_path: Mutex::new(None),
            snapshot: Arc::new(RwLock::new(CoreConnectorSnapshot::default())),
        }
    }

    pub(crate) async fn ensure_for_directory(&self, directory: &Path) -> Result<(), String> {
        let database_path = directory.join(database::DATABASE_FILENAME);
        let same_database = self.database_path.lock().await.as_ref() == Some(&database_path);
        if same_database && !self.runtime.tasks.lock().await.is_empty() {
            return Ok(());
        }
        if !same_database {
            quiesce_for_data_migration(&self.runtime).await;
        }
        *self.database_path.lock().await = Some(database_path.clone());
        let pool = database::get_pool_for_path(&database_path, false).await?;
        let rows = sqlx::query(
            "SELECT id, client_id FROM im_connectors WHERE enabled = 1 ORDER BY created_at ASC",
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(database::database_error)?;
        let mut started = 0_usize;
        let mut errors = Vec::new();
        for row in rows {
            let connector_id: String = row.get("id");
            let client_id: String = row.get("client_id");
            let client_secret = secret_store::get_secret_value_from_directory(
                &self.app_local_data_directory,
                &self.secrets,
                &secret_key(&connector_id),
            )
            .await?;
            if client_secret.trim().is_empty() {
                let error = "缺少 Client Secret，请重新编辑连接";
                update_runtime_status(
                    pool.as_ref(),
                    &connector_id,
                    "auth_error",
                    Some(error),
                    false,
                )
                .await?;
                errors.push(format!("{connector_id}: {error}"));
                continue;
            }
            spawn_connector_with_pool(
                &self.runtime,
                Arc::clone(&pool),
                DingTalkStartInput {
                    connector_id,
                    client_id,
                    data_directory: Some(directory.to_string_lossy().into_owned()),
                },
                client_secret,
                ConnectorEventSink::Core(Arc::clone(&self.snapshot)),
            )
            .await?;
            started += 1;
        }
        let mut snapshot = self.snapshot.write().await;
        snapshot.status = if errors.is_empty() {
            CoreConnectorStatus::Running
        } else {
            CoreConnectorStatus::Degraded
        };
        snapshot.active_connector_count = started;
        snapshot.last_error = (!errors.is_empty()).then(|| errors.join("；"));
        Ok(())
    }

    pub(crate) async fn snapshot(&self) -> CoreConnectorSnapshot {
        self.snapshot.read().await.clone()
    }

    pub(crate) async fn reconcile_for_directory(&self, directory: &Path) -> Result<usize, String> {
        quiesce_for_data_migration(&self.runtime).await;
        *self.database_path.lock().await = None;
        self.ensure_for_directory(directory).await?;
        Ok(self.snapshot.read().await.active_connector_count)
    }

    pub(crate) async fn quiesce(&self) -> CoreConnectorMigrationSnapshot {
        let was_running = matches!(
            self.snapshot.read().await.status,
            CoreConnectorStatus::Running | CoreConnectorStatus::Degraded
        );
        quiesce_for_data_migration(&self.runtime).await;
        let mut snapshot = self.snapshot.write().await;
        snapshot.status = CoreConnectorStatus::Paused;
        snapshot.active_connector_count = 0;
        CoreConnectorMigrationSnapshot { was_running }
    }

    pub(crate) async fn quiesce_if_directory(&self, directory: &Path) {
        let database_path = directory.join(database::DATABASE_FILENAME);
        if self.database_path.lock().await.as_ref() == Some(&database_path) {
            self.quiesce().await;
        }
    }

    pub(crate) async fn shutdown(&self) {
        quiesce_for_data_migration(&self.runtime).await;
        let mut snapshot = self.snapshot.write().await;
        snapshot.status = CoreConnectorStatus::Stopped;
        snapshot.active_connector_count = 0;
    }
}

#[derive(Clone)]
enum ConnectorEventSink {
    Core(Arc<RwLock<CoreConnectorSnapshot>>),
}

pub(crate) async fn quiesce_for_data_migration(runtime: &DingTalkRuntimeState) {
    let tasks = runtime
        .tasks
        .lock()
        .await
        .drain()
        .map(|(_, task)| task)
        .collect::<Vec<_>>();
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkConnectionInput {
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkSecretInput {
    connector_id: String,
    client_secret: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkStartInput {
    connector_id: String,
    client_id: String,
    data_directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkConnectionResult {
    endpoint_host: String,
}

#[derive(Debug, Deserialize)]
struct ConnectionTicket {
    endpoint: String,
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamEnvelope {
    #[serde(rename = "type")]
    envelope_type: String,
    #[serde(default)]
    headers: StreamHeaders,
    #[serde(default)]
    data: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamHeaders {
    #[serde(default)]
    topic: String,
    #[serde(default)]
    message_id: String,
    #[serde(default)]
    time: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkMessageEvent {
    connector_id: String,
    message_id: String,
    received_at: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct NormalizedBotMessage {
    remote_message_id: String,
    remote_conversation_id: String,
    conversation_type: &'static str,
    conversation_title: String,
    sender_id: String,
    sender_name: String,
    sent_at: i64,
    message_type: String,
    body_text: String,
    attachment_count: i64,
}

#[tauri::command]
pub async fn test_dingtalk_connection(
    input: DingTalkConnectionInput,
) -> Result<DingTalkConnectionResult, String> {
    validate_credentials(&input.client_id, &input.client_secret)?;
    let ticket = register_connection(&input.client_id, &input.client_secret)
        .await
        .map_err(|(message, _)| message)?;
    let endpoint = Url::parse(&ticket.endpoint).map_err(stream_error)?;
    Ok(DingTalkConnectionResult {
        endpoint_host: endpoint.host_str().unwrap_or_default().to_string(),
    })
}

#[tauri::command]
pub async fn set_dingtalk_connector_secret(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    input: DingTalkSecretInput,
) -> Result<(), String> {
    if input.connector_id.trim().is_empty() || input.client_secret.trim().is_empty() {
        return Err("钉钉连接器 ID 和 Client Secret 不能为空".to_string());
    }
    secret_store::set_secret_value(
        &app,
        &state,
        &secret_key(&input.connector_id),
        input.client_secret.trim().to_string(),
    )
    .await
}

#[tauri::command]
pub async fn delete_dingtalk_connector_secret(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    connector_id: String,
) -> Result<(), String> {
    secret_store::set_secret_value(&app, &state, &secret_key(&connector_id), String::new()).await
}

#[tauri::command]
pub async fn start_dingtalk_connector(
    app: AppHandle,
    core_state: State<'_, crate::core_supervisor::HeadlessCoreSupervisorState>,
    input: DingTalkStartInput,
) -> Result<(), String> {
    if input.connector_id.trim().is_empty() || input.client_id.trim().is_empty() {
        return Err("钉钉连接器 ID 和 Client ID 不能为空".to_string());
    }
    let directory = database::configured_data_directory(&app, input.data_directory)
        .map_err(database::database_error)?;
    let endpoint = crate::core_supervisor::active_endpoint(&app, core_state.inner()).await?;
    crate::core_server::reconcile_connectors(&endpoint, &directory)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn stop_dingtalk_connector(
    app: AppHandle,
    core_state: State<'_, crate::core_supervisor::HeadlessCoreSupervisorState>,
    connector_id: String,
    data_directory: Option<String>,
) -> Result<(), String> {
    if connector_id.trim().is_empty() {
        return Err("钉钉连接器 ID 不能为空".to_string());
    }
    let directory = database::configured_data_directory(&app, data_directory)
        .map_err(database::database_error)?;
    let endpoint = crate::core_supervisor::active_endpoint(&app, core_state.inner()).await?;
    crate::core_server::reconcile_connectors(&endpoint, &directory)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn resume_dingtalk_connectors(
    app: AppHandle,
    core_state: State<'_, crate::core_supervisor::HeadlessCoreSupervisorState>,
    data_directory: Option<String>,
) -> Result<usize, String> {
    let directory = database::configured_data_directory(&app, data_directory)
        .map_err(database::database_error)?;
    let endpoint = crate::core_supervisor::active_endpoint(&app, core_state.inner()).await?;
    crate::core_server::reconcile_connectors(&endpoint, &directory).await
}

async fn spawn_connector_with_pool(
    runtime: &DingTalkRuntimeState,
    pool: Arc<SqlitePool>,
    input: DingTalkStartInput,
    client_secret: String,
    event_sink: ConnectorEventSink,
) -> Result<(), String> {
    let mut tasks = runtime.tasks.lock().await;
    if let Some(existing) = tasks.get(&input.connector_id) {
        if !existing.is_finished() {
            return Ok(());
        }
    }
    tasks.remove(&input.connector_id);
    let connector_id = input.connector_id.clone();
    let handle = tokio::spawn(async move {
        run_connector(pool, input, client_secret, event_sink).await;
    });
    tasks.insert(connector_id, handle);
    Ok(())
}

async fn run_connector(
    pool: Arc<SqlitePool>,
    input: DingTalkStartInput,
    client_secret: String,
    event_sink: ConnectorEventSink,
) {
    let mut delay_seconds = 2_u64;
    let _ = update_runtime_status(&pool, &input.connector_id, "connecting", None, false).await;

    loop {
        match run_connection_once(&event_sink, pool.as_ref(), &input, &client_secret).await {
            Ok(()) => {
                delay_seconds = 2;
            }
            Err((message, authentication_error)) => {
                let safe_message = redact_sensitive_text(&message);
                let status = if authentication_error {
                    "auth_error"
                } else {
                    "reconnecting"
                };
                let _ = update_runtime_status(
                    &pool,
                    &input.connector_id,
                    status,
                    Some(&safe_message),
                    false,
                )
                .await;
                if authentication_error {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(delay_seconds)).await;
                delay_seconds = (delay_seconds * 2).min(60);
            }
        }
    }
}

async fn run_connection_once(
    event_sink: &ConnectorEventSink,
    pool: &SqlitePool,
    input: &DingTalkStartInput,
    client_secret: &str,
) -> Result<(), (String, bool)> {
    let ticket = register_connection(&input.client_id, client_secret).await?;
    let mut endpoint = Url::parse(&ticket.endpoint)
        .map_err(|error| (format!("钉钉返回了无效的 Stream 地址：{error}"), false))?;
    endpoint
        .query_pairs_mut()
        .append_pair("ticket", &ticket.ticket);

    let (socket, _) = connect_async(endpoint.as_str())
        .await
        .map_err(|error| (format!("无法建立钉钉 Stream 连接：{error}"), false))?;
    update_runtime_status(pool, &input.connector_id, "online", None, true)
        .await
        .map_err(|error| (error, false))?;
    let (mut writer, mut reader) = socket.split();

    while let Some(frame) = reader.next().await {
        let frame = frame.map_err(|error| (format!("钉钉 Stream 连接已中断：{error}"), false))?;
        match frame {
            Message::Text(text) => {
                let envelope: StreamEnvelope = serde_json::from_str(text.as_str())
                    .map_err(|error| (format!("无法解析钉钉 Stream 消息：{error}"), false))?;
                if envelope.envelope_type == "SYSTEM" && envelope.headers.topic == "disconnect" {
                    return Ok(());
                }
                if envelope.envelope_type == "SYSTEM" && envelope.headers.topic == "ping" {
                    let data = normalize_ping_data(&envelope.data);
                    writer
                        .send(Message::Text(
                            build_ack(&envelope.headers.message_id, data).into(),
                        ))
                        .await
                        .map_err(|error| (format!("回复钉钉心跳失败：{error}"), false))?;
                    continue;
                }
                if envelope.envelope_type == "CALLBACK"
                    && envelope.headers.topic == BOT_MESSAGE_TOPIC
                {
                    let received_at = envelope_time(&envelope.headers).unwrap_or_else(now_millis);
                    if let Some(message) = normalize_bot_message(
                        &envelope.data,
                        &envelope.headers.message_id,
                        received_at,
                    )
                    .map_err(|error| (error, false))?
                    {
                        let inserted =
                            persist_bot_message(pool, &input.connector_id, &message, received_at)
                                .await
                                .map_err(|error| (error, false))?;
                        if inserted {
                            publish_connector_event(
                                event_sink,
                                DingTalkMessageEvent {
                                    connector_id: input.connector_id.clone(),
                                    message_id: message.remote_message_id,
                                    received_at,
                                },
                            )
                            .await;
                        }
                    }
                    writer
                        .send(Message::Text(
                            build_ack(&envelope.headers.message_id, "{\"response\":null}".into())
                                .into(),
                        ))
                        .await
                        .map_err(|error| (format!("回复钉钉消息确认失败：{error}"), false))?;
                }
            }
            Message::Ping(data) => writer
                .send(Message::Pong(data))
                .await
                .map_err(|error| (format!("回复 WebSocket 心跳失败：{error}"), false))?,
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
    Err(("钉钉 Stream 连接意外结束".to_string(), false))
}

async fn publish_connector_event(event_sink: &ConnectorEventSink, event: DingTalkMessageEvent) {
    match event_sink {
        ConnectorEventSink::Core(snapshot) => {
            let mut snapshot = snapshot.write().await;
            snapshot.received_message_count = snapshot.received_message_count.saturating_add(1);
            snapshot.last_event_at = Some(event.received_at);
        }
    }
}

async fn register_connection(
    client_id: &str,
    client_secret: &str,
) -> Result<ConnectionTicket, (String, bool)> {
    let response = reqwest::Client::new()
        .post(CONNECTION_URL)
        .header("Accept", "application/json")
        .json(&json!({
            "clientId": client_id,
            "clientSecret": client_secret,
            "subscriptions": [{ "topic": BOT_MESSAGE_TOPIC, "type": "CALLBACK" }],
            "ua": "mynotebook-sdk-rust/0.1.0"
        }))
        .send()
        .await
        .map_err(|error| (format!("无法连接钉钉开放平台：{error}"), false))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let authentication_error = matches!(status.as_u16(), 400 | 401 | 403);
        return Err((
            redact_sensitive_text(&format!(
                "钉钉 Stream 鉴权失败（HTTP {}）：{}",
                status.as_u16(),
                body
            )),
            authentication_error,
        ));
    }
    response
        .json::<ConnectionTicket>()
        .await
        .map_err(|error| (format!("无法解析钉钉 Stream 凭证：{error}"), false))
}

async fn persist_bot_message(
    pool: &SqlitePool,
    connector_id: &str,
    message: &NormalizedBotMessage,
    received_at: i64,
) -> Result<bool, String> {
    let conversation_id = stable_id(
        "dingtalk-conversation",
        &[connector_id, &message.remote_conversation_id],
    );
    let message_id = stable_id(
        "dingtalk-message",
        &[connector_id, &message.remote_message_id],
    );
    let mut transaction = pool.begin().await.map_err(database::database_error)?;
    sqlx::query(
        "INSERT INTO im_conversations
         (id, connector_id, remote_conversation_id, conversation_type, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connector_id, remote_conversation_id) DO UPDATE SET
           conversation_type = excluded.conversation_type,
           title = excluded.title,
           updated_at = excluded.updated_at",
    )
    .bind(&conversation_id)
    .bind(connector_id)
    .bind(&message.remote_conversation_id)
    .bind(message.conversation_type)
    .bind(&message.conversation_title)
    .bind(received_at)
    .bind(received_at)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;

    let result = sqlx::query(
        "INSERT OR IGNORE INTO im_messages
         (id, connector_id, conversation_id, remote_message_id, sender_id, sender_name,
          sent_at, received_at, message_type, body_text, attachment_count, processing_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
    )
    .bind(message_id)
    .bind(connector_id)
    .bind(conversation_id)
    .bind(&message.remote_message_id)
    .bind(&message.sender_id)
    .bind(&message.sender_name)
    .bind(message.sent_at)
    .bind(received_at)
    .bind(&message.message_type)
    .bind(&message.body_text)
    .bind(message.attachment_count)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;

    sqlx::query(
        "UPDATE im_connectors
         SET runtime_status = 'online', last_event_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ?",
    )
    .bind(received_at)
    .bind(received_at)
    .bind(connector_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(result.rows_affected() > 0)
}

async fn update_runtime_status(
    pool: &SqlitePool,
    connector_id: &str,
    status: &str,
    error: Option<&str>,
    connected: bool,
) -> Result<(), String> {
    let now = now_millis();
    sqlx::query(
        "UPDATE im_connectors SET runtime_status = ?, last_error = ?,
         last_connected_at = CASE WHEN ? THEN ? ELSE last_connected_at END,
         updated_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(error)
    .bind(connected)
    .bind(now)
    .bind(now)
    .bind(connector_id)
    .execute(pool)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

fn normalize_bot_message(
    data: &str,
    envelope_message_id: &str,
    received_at: i64,
) -> Result<Option<NormalizedBotMessage>, String> {
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("无法解析钉钉机器人消息：{error}"))?;
    let remote_conversation_id = string_field(&value, "conversationId");
    if remote_conversation_id.is_empty() {
        return Ok(None);
    }
    let remote_message_id = non_empty(&string_field(&value, "msgId"), envelope_message_id);
    if remote_message_id.is_empty() {
        return Ok(None);
    }
    let sender_name = string_field(&value, "senderNick");
    let sender_id = non_empty(
        &string_field(&value, "senderStaffId"),
        &string_field(&value, "senderId"),
    );
    let conversation_type = if string_field(&value, "conversationType") == "2" {
        "group"
    } else {
        "direct"
    };
    let title = if conversation_type == "group" {
        non_empty(&string_field(&value, "conversationTitle"), "未命名群聊")
    } else {
        non_empty(&sender_name, "钉钉单聊")
    };
    let message_type = non_empty(&string_field(&value, "msgtype"), "unknown");
    let (body_text, attachment_count) = extract_message_body(&value, &message_type);
    let sent_at = integer_field(&value, "createAt")
        .or_else(|| integer_field(&value, "createA"))
        .unwrap_or(received_at);
    Ok(Some(NormalizedBotMessage {
        remote_message_id,
        remote_conversation_id,
        conversation_type,
        conversation_title: title,
        sender_id,
        sender_name,
        sent_at,
        message_type,
        body_text: truncate_chars(body_text.trim(), MAX_MESSAGE_CHARS),
        attachment_count,
    }))
}

fn extract_message_body(value: &Value, message_type: &str) -> (String, i64) {
    if message_type.eq_ignore_ascii_case("text") {
        return (
            value
                .pointer("/text/content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            0,
        );
    }
    if message_type.eq_ignore_ascii_case("richText") {
        let mut fragments = Vec::new();
        collect_text_fragments(
            value.get("content").or_else(|| value.get("richText")),
            &mut fragments,
        );
        return (fragments.join("\n"), 0);
    }
    let label = match message_type.to_ascii_lowercase().as_str() {
        "picture" | "image" => "[图片]".to_string(),
        "file" => "[文件]".to_string(),
        "audio" | "voice" => "[语音]".to_string(),
        "video" => "[视频]".to_string(),
        _ => format!("[暂不支持的钉钉消息类型：{message_type}]"),
    };
    (label, 1)
}

fn collect_text_fragments(value: Option<&Value>, output: &mut Vec<String>) {
    let Some(value) = value else { return };
    match value {
        Value::Array(values) => {
            for value in values {
                collect_text_fragments(Some(value), output);
            }
        }
        Value::Object(values) => {
            if let Some(text) = values.get("text").and_then(Value::as_str) {
                let text = text.trim();
                if !text.is_empty() {
                    output.push(text.to_string());
                }
            }
            for (key, value) in values {
                if key != "text" {
                    collect_text_fragments(Some(value), output);
                }
            }
        }
        _ => {}
    }
}

fn build_ack(message_id: &str, data: String) -> String {
    json!({
        "code": 200,
        "headers": { "contentType": "application/json", "messageId": message_id },
        "message": "OK",
        "data": data
    })
    .to_string()
}

fn normalize_ping_data(data: &str) -> String {
    serde_json::from_str::<Value>(data)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "{\"opaque\":\"\"}".to_string())
}

fn envelope_time(headers: &StreamHeaders) -> Option<i64> {
    match headers.time.as_ref()? {
        Value::Number(value) => value.as_i64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn validate_credentials(client_id: &str, client_secret: &str) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Err("Client ID 不能为空".to_string());
    }
    if client_secret.trim().is_empty() {
        return Err("Client Secret 不能为空".to_string());
    }
    Ok(())
}

fn secret_key(connector_id: &str) -> String {
    format!("{SECRET_PREFIX}:{}:client_secret", connector_id.trim())
}

fn stable_id(namespace: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    for value in values {
        hasher.update([0]);
        hasher.update(value.as_bytes());
    }
    format!("{namespace}-{:x}", hasher.finalize())
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn integer_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

fn non_empty(primary: &str, fallback: &str) -> String {
    if primary.trim().is_empty() {
        fallback.trim().to_string()
    } else {
        primary.trim().to_string()
    }
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn stream_error(error: impl std::fmt::Display) -> String {
    format!("钉钉 Stream 操作失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_text_bot_message_and_legacy_create_time() {
        let message = normalize_bot_message(
            r#"{"conversationId":"cid-1","conversationType":"2","conversationTitle":"项目群","msgId":"msg-1","senderNick":"小李","senderStaffId":"u-1","createA":1690362101894,"text":{"content":" 进度如何？ "},"msgtype":"text"}"#,
            "envelope-1",
            1700000000000,
        )
        .unwrap()
        .unwrap();
        assert_eq!(message.remote_message_id, "msg-1");
        assert_eq!(message.conversation_type, "group");
        assert_eq!(message.conversation_title, "项目群");
        assert_eq!(message.body_text, "进度如何？");
        assert_eq!(message.sent_at, 1690362101894);
    }

    #[test]
    fn bot_ack_echoes_message_id_and_null_response() {
        let ack: Value = serde_json::from_str(&build_ack(
            "stream-message-1",
            "{\"response\":null}".to_string(),
        ))
        .unwrap();
        assert_eq!(ack["code"], 200);
        assert_eq!(ack["headers"]["messageId"], "stream-message-1");
        assert_eq!(ack["data"], "{\"response\":null}");
    }

    #[test]
    fn stable_ids_are_deterministic_and_namespaced() {
        assert_eq!(
            stable_id("dingtalk-message", &["connector", "remote"]),
            stable_id("dingtalk-message", &["connector", "remote"])
        );
        assert_ne!(
            stable_id("dingtalk-message", &["connector", "remote"]),
            stable_id("dingtalk-conversation", &["connector", "remote"])
        );
    }

    #[tokio::test]
    async fn data_migration_quiesce_stops_all_connectors() {
        let runtime = DingTalkRuntimeState::default();
        let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct DropSignal(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }

        let signal = std::sync::Arc::clone(&stopped);
        runtime.tasks.lock().await.insert(
            "connector-1".to_string(),
            tokio::spawn(async move {
                let _signal = DropSignal(signal);
                std::future::pending::<()>().await;
            }),
        );
        tokio::task::yield_now().await;

        quiesce_for_data_migration(&runtime).await;

        assert!(runtime.tasks.lock().await.is_empty());
        assert!(stopped.load(std::sync::atomic::Ordering::SeqCst));
    }
}
