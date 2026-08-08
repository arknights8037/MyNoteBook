use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    sync::{broadcast, Mutex, RwLock},
    task::JoinHandle,
    time::{Duration, MissedTickBehavior},
};

use crate::{database, governance::ClaimedOutboxMessage, reliability::now_millis};

const OUTBOX_LEASE_MS: i64 = 30_000;
const OUTBOX_BATCH_SIZE: i64 = 50;
const OUTBOX_STATUS_EVENT: &str = "outbox-dispatcher://status";

pub(crate) struct OutboxDispatcherProjectionState {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Default for OutboxDispatcherProjectionState {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PublishedOutboxEvent {
    pub(crate) event_id: String,
    pub(crate) topic: String,
    pub(crate) payload: serde_json::Value,
}

impl From<&ClaimedOutboxMessage> for PublishedOutboxEvent {
    fn from(message: &ClaimedOutboxMessage) -> Self {
        Self {
            event_id: message.event_id.clone(),
            topic: message.topic.clone(),
            payload: message.payload.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OutboxDispatcherStatus {
    Stopped,
    Running,
    Paused,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutboxDispatcherSnapshot {
    status: OutboxDispatcherStatus,
    last_tick_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error: Option<String>,
    published_count: u64,
    pending_count: i64,
    processing_count: i64,
    retry_count: i64,
    dead_letter_count: i64,
}

impl Default for OutboxDispatcherSnapshot {
    fn default() -> Self {
        Self {
            status: OutboxDispatcherStatus::Stopped,
            last_tick_at: None,
            last_success_at: None,
            last_error: None,
            published_count: 0,
            pending_count: 0,
            processing_count: 0,
            retry_count: 0,
            dead_letter_count: 0,
        }
    }
}

#[tauri::command]
pub(crate) async fn get_outbox_dispatcher_snapshot(
    app: AppHandle,
    core_state: State<'_, crate::core_supervisor::HeadlessCoreSupervisorState>,
) -> Result<OutboxDispatcherSnapshot, String> {
    let endpoint = crate::core_supervisor::active_endpoint(&app, core_state.inner()).await?;
    crate::core_server::get_outbox_dispatcher_snapshot(&endpoint).await
}

pub(crate) async fn ensure_snapshot_projection(
    app: &AppHandle,
    state: &OutboxDispatcherProjectionState,
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
        run_snapshot_projection(app).await;
    }));
    Ok(())
}

async fn run_snapshot_projection(app: AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let core_state = app.state::<crate::core_supervisor::HeadlessCoreSupervisorState>();
        let snapshot = match crate::core_supervisor::active_endpoint(&app, core_state.inner()).await
        {
            Ok(endpoint) => crate::core_server::get_outbox_dispatcher_snapshot(&endpoint).await,
            Err(error) => Err(error),
        };
        let projection = snapshot.unwrap_or_else(OutboxDispatcherSnapshot::degraded);
        let _ = app.emit(OUTBOX_STATUS_EVENT, projection);
    }
}

impl OutboxDispatcherSnapshot {
    fn degraded(error: String) -> Self {
        Self {
            status: OutboxDispatcherStatus::Degraded,
            last_tick_at: Some(now_millis()),
            last_error: Some(truncate_error(&error)),
            ..Self::default()
        }
    }
}

#[derive(Debug)]
struct OutboxMetrics {
    pending_count: i64,
    processing_count: i64,
    retry_count: i64,
    dead_letter_count: i64,
}

pub(crate) struct CoreOutboxDispatcherMigrationSnapshot {
    pub(crate) was_running: bool,
}

pub(crate) struct CoreOutboxDispatcherState {
    task: Mutex<Option<JoinHandle<()>>>,
    database_path: Mutex<Option<PathBuf>>,
    snapshot: Arc<RwLock<OutboxDispatcherSnapshot>>,
    event_bus: broadcast::Sender<PublishedOutboxEvent>,
}

impl Default for CoreOutboxDispatcherState {
    fn default() -> Self {
        let (event_bus, _) = broadcast::channel(256);
        Self::new(event_bus)
    }
}

impl CoreOutboxDispatcherState {
    pub(crate) fn new(event_bus: broadcast::Sender<PublishedOutboxEvent>) -> Self {
        Self {
            task: Mutex::new(None),
            database_path: Mutex::new(None),
            snapshot: Arc::new(RwLock::new(OutboxDispatcherSnapshot::default())),
            event_bus,
        }
    }

    pub(crate) async fn ensure_for_directory(&self, directory: &Path) -> Result<(), String> {
        let database_path = directory.join(database::DATABASE_FILENAME);
        let mut task = self.task.lock().await;
        let same_database = self.database_path.lock().await.as_ref() == Some(&database_path);
        if same_database && task.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        if let Some(existing) = task.take() {
            existing.abort();
            let _ = existing.await;
        }
        *self.database_path.lock().await = Some(database_path.clone());
        update_snapshot(&self.snapshot, |snapshot| {
            snapshot.status = OutboxDispatcherStatus::Running;
            snapshot.last_error = None;
        })
        .await;
        let snapshot = Arc::clone(&self.snapshot);
        let event_bus = self.event_bus.clone();
        *task = Some(tokio::spawn(async move {
            run_dispatcher(database_path, snapshot, event_bus).await;
        }));
        Ok(())
    }

    pub(crate) async fn snapshot(&self) -> OutboxDispatcherSnapshot {
        self.snapshot.read().await.clone()
    }

    pub(crate) async fn quiesce(&self) -> CoreOutboxDispatcherMigrationSnapshot {
        let existing = self.task.lock().await.take();
        let was_running = existing.as_ref().is_some_and(|task| !task.is_finished());
        if let Some(existing) = existing {
            existing.abort();
            let _ = existing.await;
        }
        self.snapshot.write().await.status = OutboxDispatcherStatus::Paused;
        CoreOutboxDispatcherMigrationSnapshot { was_running }
    }

    pub(crate) async fn quiesce_if_directory(&self, directory: &Path) {
        let database_path = directory.join(database::DATABASE_FILENAME);
        if self.database_path.lock().await.as_ref() == Some(&database_path) {
            self.quiesce().await;
        }
    }

    pub(crate) async fn shutdown(&self) {
        let existing = self.task.lock().await.take();
        if let Some(existing) = existing {
            existing.abort();
            let _ = existing.await;
        }
        self.snapshot.write().await.status = OutboxDispatcherStatus::Stopped;
    }
}

async fn run_dispatcher(
    database_path: PathBuf,
    snapshot: Arc<RwLock<OutboxDispatcherSnapshot>>,
    event_bus: broadcast::Sender<PublishedOutboxEvent>,
) {
    let worker_id = format!("core-outbox-{}", std::process::id());
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let now = now_millis();
        update_snapshot(&snapshot, |snapshot| {
            snapshot.status = OutboxDispatcherStatus::Running;
            snapshot.last_tick_at = Some(now);
        })
        .await;
        let connection = match database::get_pool_for_path(&database_path, false).await {
            Ok(connection) => connection,
            Err(error) => {
                record_error(&snapshot, error).await;
                continue;
            }
        };
        let messages = match crate::governance::claim_outbox_from_pool(
            connection.as_ref(),
            &worker_id,
            now,
            OUTBOX_LEASE_MS,
            OUTBOX_BATCH_SIZE,
        )
        .await
        {
            Ok(messages) => messages,
            Err(error) => {
                record_error(&snapshot, error).await;
                continue;
            }
        };
        let mut published = 0_u64;
        let mut errors = Vec::new();
        for message in messages {
            let delivery = event_bus
                .send(PublishedOutboxEvent::from(&message))
                .map(|_| ())
                .map_err(|_| "Core Outbox 没有活动领域事件订阅者。".to_string());
            let delivered = delivery.is_ok();
            let delivery_error = delivery.err();
            match crate::governance::settle_outbox_in_pool(
                connection.as_ref(),
                &message.id,
                &worker_id,
                delivered,
                delivery_error.as_deref(),
                now,
            )
            .await
            {
                Ok(()) if delivered => published += 1,
                Ok(()) => errors.push("Core Outbox 事件总线暂不可用。".to_string()),
                Err(error) => errors.push(error),
            }
        }
        let metrics = read_metrics(connection.as_ref()).await;
        update_snapshot(&snapshot, |snapshot| {
            snapshot.published_count = snapshot.published_count.saturating_add(published);
            match metrics {
                Ok(metrics) => {
                    snapshot.pending_count = metrics.pending_count;
                    snapshot.processing_count = metrics.processing_count;
                    snapshot.retry_count = metrics.retry_count;
                    snapshot.dead_letter_count = metrics.dead_letter_count;
                }
                Err(error) => errors.push(error),
            }
            if errors.is_empty() {
                snapshot.status = OutboxDispatcherStatus::Running;
                snapshot.last_success_at = Some(now);
                snapshot.last_error = None;
            } else {
                snapshot.status = OutboxDispatcherStatus::Degraded;
                snapshot.last_error = Some(truncate_error(&errors.join("；")));
            }
        })
        .await;
    }
}

async fn read_metrics(connection: &SqlitePool) -> Result<OutboxMetrics, String> {
    let row = sqlx::query(
        "SELECT \
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count, \
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_count, \
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS retry_count, \
           SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_letter_count \
         FROM outbox_messages",
    )
    .fetch_one(connection)
    .await
    .map_err(database::database_error)?;
    Ok(OutboxMetrics {
        pending_count: row
            .try_get::<Option<i64>, _>("pending_count")
            .unwrap_or(None)
            .unwrap_or(0),
        processing_count: row
            .try_get::<Option<i64>, _>("processing_count")
            .unwrap_or(None)
            .unwrap_or(0),
        retry_count: row
            .try_get::<Option<i64>, _>("retry_count")
            .unwrap_or(None)
            .unwrap_or(0),
        dead_letter_count: row
            .try_get::<Option<i64>, _>("dead_letter_count")
            .unwrap_or(None)
            .unwrap_or(0),
    })
}

async fn update_snapshot(
    snapshot: &Arc<RwLock<OutboxDispatcherSnapshot>>,
    update: impl FnOnce(&mut OutboxDispatcherSnapshot),
) {
    let mut guard = snapshot.write().await;
    update(&mut guard);
}

async fn record_error(snapshot: &Arc<RwLock<OutboxDispatcherSnapshot>>, error: String) {
    update_snapshot(snapshot, |snapshot| {
        snapshot.status = OutboxDispatcherStatus::Degraded;
        snapshot.last_error = Some(truncate_error(&error));
    })
    .await;
}

fn truncate_error(error: &str) -> String {
    error.chars().take(1_000).collect()
}
