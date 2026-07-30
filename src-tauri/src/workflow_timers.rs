use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    sync::{Mutex, RwLock},
    task::JoinHandle,
    time::{Duration, MissedTickBehavior},
};

use crate::{
    database,
    domain_events::{record_with_outbox, NewDomainEvent},
    reliability::{clamp_lease_ms, now_millis, TIMER_RETRY_POLICY},
};

const TIMER_LEASE_MS: i64 = 30_000;
const TIMER_BATCH_SIZE: i64 = 25;
const TIMER_STATUS_EVENT: &str = "workflow-timer://status";

pub(crate) struct DurableTimerSchedulerState {
    task: Mutex<Option<JoinHandle<()>>>,
    data_directory: Mutex<Option<String>>,
    migration_paused: AtomicBool,
    snapshot: RwLock<DurableTimerSnapshot>,
}

impl Default for DurableTimerSchedulerState {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
            data_directory: Mutex::new(None),
            migration_paused: AtomicBool::new(false),
            snapshot: RwLock::new(DurableTimerSnapshot::default()),
        }
    }
}

pub(crate) struct DurableTimerMigrationSnapshot {
    pub(crate) was_running: bool,
    pub(crate) data_directory: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DurableTimerStatus {
    Stopped,
    Running,
    Paused,
    Degraded,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurableTimerSnapshot {
    status: DurableTimerStatus,
    last_tick_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error: Option<String>,
    scheduled_count: i64,
    processing_count: i64,
    retry_count: i64,
    due_count: i64,
    dead_letter_count: i64,
    max_lag_ms: i64,
}

impl Default for DurableTimerSnapshot {
    fn default() -> Self {
        Self {
            status: DurableTimerStatus::Stopped,
            last_tick_at: None,
            last_success_at: None,
            last_error: None,
            scheduled_count: 0,
            processing_count: 0,
            retry_count: 0,
            due_count: 0,
            dead_letter_count: 0,
            max_lag_ms: 0,
        }
    }
}

#[derive(Debug)]
struct DurableTimerMetrics {
    scheduled_count: i64,
    processing_count: i64,
    retry_count: i64,
    due_count: i64,
    dead_letter_count: i64,
    max_lag_ms: i64,
}

#[tauri::command]
pub(crate) async fn get_workflow_timer_snapshot(
    state: State<'_, DurableTimerSchedulerState>,
) -> Result<DurableTimerSnapshot, String> {
    Ok(state.snapshot.read().await.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Internal Phase 5 Workflow input; not registered for WebView invocation.
pub(crate) struct ScheduleWorkflowTimerInput {
    data_directory: Option<String>,
    workflow_id: String,
    deduplication_key: String,
    due_at: i64,
    payload: Value,
    correlation_id: String,
    causation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Internal Phase 5 Workflow input; not registered for WebView invocation.
pub(crate) struct CancelWorkflowTimerInput {
    data_directory: Option<String>,
    wait_condition_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ScheduledWorkflowTimer {
    timer_id: String,
    wait_condition_id: String,
    workflow_id: String,
    due_at: i64,
}

#[derive(Debug)]
struct ClaimedWorkflowTimer {
    id: String,
    workflow_id: String,
    wait_condition_id: String,
    due_at: i64,
    payload: Value,
    correlation_id: String,
    causation_id: Option<String>,
    attempt_count: i64,
}

#[allow(dead_code)]
struct NewWorkflowTimer<'a> {
    workflow_id: &'a str,
    deduplication_key: &'a str,
    due_at: i64,
    payload: &'a Value,
    correlation_id: &'a str,
    causation_id: Option<&'a str>,
}

#[allow(dead_code)] // Kept as a Rust-internal primitive; absent from invoke_handler.
pub(crate) async fn schedule_workflow_timer(
    app: AppHandle,
    input: ScheduleWorkflowTimerInput,
) -> Result<ScheduledWorkflowTimer, String> {
    let connection = database::open_database(&app, input.data_directory).await?;
    schedule_workflow_timer_in_pool(
        connection.as_ref(),
        NewWorkflowTimer {
            workflow_id: &input.workflow_id,
            deduplication_key: &input.deduplication_key,
            due_at: input.due_at,
            payload: &input.payload,
            correlation_id: &input.correlation_id,
            causation_id: input.causation_id.as_deref(),
        },
        now_millis(),
    )
    .await
}

#[allow(dead_code)] // Kept as a Rust-internal primitive; absent from invoke_handler.
pub(crate) async fn cancel_workflow_timer(
    app: AppHandle,
    input: CancelWorkflowTimerInput,
) -> Result<(), String> {
    require_non_empty(&input.wait_condition_id, "等待条件 ID")?;
    let connection = database::open_database(&app, input.data_directory).await?;
    cancel_workflow_timer_in_pool(connection.as_ref(), &input.wait_condition_id, now_millis()).await
}

pub(crate) async fn ensure_scheduler(
    app: &AppHandle,
    state: &DurableTimerSchedulerState,
    data_directory: Option<String>,
) -> Result<(), String> {
    let mut task = state.task.lock().await;
    if state.migration_paused.load(Ordering::SeqCst) {
        return Err("数据目录迁移期间不能启动 Durable Timer scheduler。".to_string());
    }
    let same_directory = *state.data_directory.lock().await == data_directory;
    if same_directory && task.as_ref().is_some_and(|task| !task.is_finished()) {
        return Ok(());
    }
    if let Some(existing) = task.take() {
        existing.abort();
    }
    *state.data_directory.lock().await = data_directory.clone();
    update_timer_snapshot(app, |snapshot| {
        snapshot.status = DurableTimerStatus::Running;
        snapshot.last_error = None;
    })
    .await;
    let app = app.clone();
    *task = Some(tokio::spawn(async move {
        run_scheduler(app, data_directory).await;
    }));
    Ok(())
}

pub(crate) async fn quiesce_for_data_migration(
    state: &DurableTimerSchedulerState,
) -> DurableTimerMigrationSnapshot {
    state.migration_paused.store(true, Ordering::SeqCst);
    let existing = state.task.lock().await.take();
    let was_running = existing.as_ref().is_some_and(|task| !task.is_finished());
    if let Some(existing) = existing {
        existing.abort();
        let _ = existing.await;
    }
    state.snapshot.write().await.status = DurableTimerStatus::Paused;
    DurableTimerMigrationSnapshot {
        was_running,
        data_directory: state.data_directory.lock().await.clone(),
    }
}

pub(crate) async fn resume_after_data_migration(
    app: &AppHandle,
    state: &DurableTimerSchedulerState,
    snapshot: DurableTimerMigrationSnapshot,
    data_directory: Option<String>,
) {
    let mut task = state.task.lock().await;
    *state.data_directory.lock().await = data_directory.clone();
    if snapshot.was_running {
        update_timer_snapshot(app, |timer_snapshot| {
            timer_snapshot.status = DurableTimerStatus::Running;
            timer_snapshot.last_error = None;
        })
        .await;
        let app = app.clone();
        *task = Some(tokio::spawn(async move {
            run_scheduler(app, data_directory).await;
        }));
    }
    state.migration_paused.store(false, Ordering::SeqCst);
}

async fn run_scheduler(app: AppHandle, data_directory: Option<String>) {
    let worker_id = new_id("timer-worker");
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let now = now_millis();
        update_timer_snapshot(&app, |snapshot| {
            snapshot.status = DurableTimerStatus::Running;
            snapshot.last_tick_at = Some(now);
        })
        .await;
        let connection = match database::open_database(&app, data_directory.clone()).await {
            Ok(connection) => connection,
            Err(error) => {
                record_timer_error(&app, now, error).await;
                continue;
            }
        };
        if let Err(error) = dead_letter_exhausted_timers(connection.as_ref(), now).await {
            record_timer_error(&app, now, error).await;
            continue;
        }
        let timers = match claim_due_timers(
            connection.as_ref(),
            &worker_id,
            now,
            TIMER_LEASE_MS,
            TIMER_BATCH_SIZE,
        )
        .await
        {
            Ok(timers) => timers,
            Err(error) => {
                record_timer_error(&app, now, error).await;
                continue;
            }
        };
        let mut last_error = None;
        for timer in timers {
            if let Err(error) =
                fire_claimed_timer(connection.as_ref(), &worker_id, &timer, now).await
            {
                if let Err(reschedule_error) = reschedule_failed_timer(
                    connection.as_ref(),
                    &worker_id,
                    &timer,
                    &error,
                    now_millis(),
                )
                .await
                {
                    last_error = Some(format!(
                        "Timer {} 触发失败且无法重排：{}；{}",
                        timer.id, error, reschedule_error
                    ));
                } else {
                    last_error = Some(format!("Timer {} 触发失败，已重排：{}", timer.id, error));
                }
            }
        }
        let metrics = match load_timer_metrics(connection.as_ref(), now).await {
            Ok(metrics) => metrics,
            Err(error) => {
                record_timer_error(&app, now, error).await;
                continue;
            }
        };
        update_timer_snapshot(&app, |snapshot| {
            snapshot.status = if last_error.is_some() {
                DurableTimerStatus::Degraded
            } else {
                DurableTimerStatus::Running
            };
            snapshot.last_success_at = Some(now);
            snapshot.last_error = last_error.map(|error| truncate_error(&error));
            snapshot.scheduled_count = metrics.scheduled_count;
            snapshot.processing_count = metrics.processing_count;
            snapshot.retry_count = metrics.retry_count;
            snapshot.due_count = metrics.due_count;
            snapshot.dead_letter_count = metrics.dead_letter_count;
            snapshot.max_lag_ms = metrics.max_lag_ms;
        })
        .await;
    }
}

async fn load_timer_metrics(
    connection: &SqlitePool,
    now: i64,
) -> Result<DurableTimerMetrics, String> {
    let row = sqlx::query(
        "SELECT \
           COALESCE(SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END), 0) AS scheduled_count, \
           COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing_count, \
           COALESCE(SUM(CASE WHEN status = 'scheduled' AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS retry_count, \
           COALESCE(SUM(CASE WHEN status = 'scheduled' AND due_at <= ? AND available_at <= ? THEN 1 ELSE 0 END), 0) AS due_count, \
           COALESCE(SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END), 0) AS dead_letter_count, \
           COALESCE(MAX(CASE WHEN status = 'scheduled' AND due_at <= ? THEN ? - due_at ELSE 0 END), 0) AS max_lag_ms \
         FROM workflow_timers",
    )
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now)
    .fetch_one(connection)
    .await
    .map_err(database::database_error)?;
    Ok(DurableTimerMetrics {
        scheduled_count: row
            .try_get("scheduled_count")
            .map_err(database::database_error)?,
        processing_count: row
            .try_get("processing_count")
            .map_err(database::database_error)?,
        retry_count: row
            .try_get("retry_count")
            .map_err(database::database_error)?,
        due_count: row.try_get("due_count").map_err(database::database_error)?,
        dead_letter_count: row
            .try_get("dead_letter_count")
            .map_err(database::database_error)?,
        max_lag_ms: row
            .try_get("max_lag_ms")
            .map_err(database::database_error)?,
    })
}

async fn update_timer_snapshot(app: &AppHandle, update: impl FnOnce(&mut DurableTimerSnapshot)) {
    let state = app.state::<DurableTimerSchedulerState>();
    let next = {
        let mut snapshot = state.snapshot.write().await;
        update(&mut snapshot);
        snapshot.clone()
    };
    let _ = app.emit(TIMER_STATUS_EVENT, next);
}

async fn record_timer_error(app: &AppHandle, now: i64, error: String) {
    update_timer_snapshot(app, |snapshot| {
        snapshot.status = DurableTimerStatus::Degraded;
        snapshot.last_tick_at = Some(now);
        snapshot.last_error = Some(truncate_error(&error));
    })
    .await;
}

fn truncate_error(error: &str) -> String {
    error.chars().take(2_000).collect()
}

#[allow(dead_code)]
async fn schedule_workflow_timer_in_pool(
    connection: &SqlitePool,
    timer: NewWorkflowTimer<'_>,
    now: i64,
) -> Result<ScheduledWorkflowTimer, String> {
    let NewWorkflowTimer {
        workflow_id,
        deduplication_key,
        due_at,
        payload,
        correlation_id,
        causation_id,
    } = timer;
    require_non_empty(workflow_id, "Workflow ID")?;
    require_non_empty(deduplication_key, "去重键")?;
    require_non_empty(correlation_id, "Correlation ID")?;
    if due_at < 0 {
        return Err("Timer 到期时间必须是有效的 UTC Unix 毫秒。".to_string());
    }
    let payload_json = payload.to_string();
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    if let Some(row) = sqlx::query(
        "SELECT timer.id AS timer_id, timer.due_at, condition.id AS condition_id, \
         condition.payload_json, condition.correlation_id, condition.causation_id \
         FROM workflow_wait_conditions condition \
         INNER JOIN workflow_timers timer ON timer.wait_condition_id = condition.id \
         WHERE condition.workflow_id = ? AND condition.deduplication_key = ? LIMIT 1",
    )
    .bind(workflow_id)
    .bind(deduplication_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database::database_error)?
    {
        let existing_due_at: i64 = row.try_get("due_at").map_err(database::database_error)?;
        let existing_payload: String = row
            .try_get("payload_json")
            .map_err(database::database_error)?;
        let existing_correlation: String = row
            .try_get("correlation_id")
            .map_err(database::database_error)?;
        let existing_causation: Option<String> = row
            .try_get("causation_id")
            .map_err(database::database_error)?;
        if existing_due_at != due_at
            || existing_payload != payload_json
            || existing_correlation != correlation_id
            || existing_causation.as_deref() != causation_id
        {
            return Err("相同 Workflow 去重键已用于不同的 Timer 请求。".to_string());
        }
        let result = ScheduledWorkflowTimer {
            timer_id: row.try_get("timer_id").map_err(database::database_error)?,
            wait_condition_id: row
                .try_get("condition_id")
                .map_err(database::database_error)?,
            workflow_id: workflow_id.to_string(),
            due_at,
        };
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
        return Ok(result);
    }

    let wait_condition_id = new_id("workflow-wait");
    let timer_id = new_id("workflow-timer");
    sqlx::query(
        "INSERT INTO workflow_wait_conditions (id, workflow_id, deduplication_key, \
         condition_kind, status, correlation_id, causation_id, payload_json, created_at, updated_at) \
         VALUES (?, ?, ?, 'timer', 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&wait_condition_id)
    .bind(workflow_id)
    .bind(deduplication_key)
    .bind(correlation_id)
    .bind(causation_id)
    .bind(&payload_json)
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "INSERT INTO workflow_timers (id, workflow_id, wait_condition_id, due_at, available_at, \
         status, attempt_count, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)",
    )
    .bind(&timer_id)
    .bind(workflow_id)
    .bind(&wait_condition_id)
    .bind(due_at)
    .bind(due_at)
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(ScheduledWorkflowTimer {
        timer_id,
        wait_condition_id,
        workflow_id: workflow_id.to_string(),
        due_at,
    })
}

#[allow(dead_code)]
async fn cancel_workflow_timer_in_pool(
    connection: &SqlitePool,
    wait_condition_id: &str,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let updated = sqlx::query(
        "UPDATE workflow_wait_conditions SET status = 'cancelled', updated_at = ? \
         WHERE id = ? AND condition_kind = 'timer' AND status = 'pending'",
    )
    .bind(now)
    .bind(wait_condition_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Timer 等待条件不存在或已进入终态。".to_string());
    }
    sqlx::query(
        "UPDATE workflow_timers SET status = 'cancelled', lease_owner = NULL, \
         lease_expires_at = NULL, updated_at = ? WHERE wait_condition_id = ? \
         AND status IN ('scheduled', 'processing')",
    )
    .bind(now)
    .bind(wait_condition_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    transaction.commit().await.map_err(database::database_error)
}

async fn claim_due_timers(
    connection: &SqlitePool,
    worker_id: &str,
    now: i64,
    lease_ms: i64,
    limit: i64,
) -> Result<Vec<ClaimedWorkflowTimer>, String> {
    require_non_empty(worker_id, "Timer worker ID")?;
    let lease_expires_at = now + clamp_lease_ms(lease_ms, 1_000, 5 * 60_000);
    let limit = limit.clamp(1, 100);
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let rows = sqlx::query(
        "WITH candidates AS ( \
           SELECT timer.id FROM workflow_timers timer \
           INNER JOIN workflow_wait_conditions condition ON condition.id = timer.wait_condition_id \
           WHERE condition.status = 'pending' AND timer.attempt_count < ? AND ( \
             (timer.status = 'scheduled' AND timer.due_at <= ? AND timer.available_at <= ?) OR \
             (timer.status = 'processing' AND timer.lease_expires_at <= ?) \
           ) ORDER BY timer.due_at ASC, timer.created_at ASC LIMIT ? \
         ) UPDATE workflow_timers SET status = 'processing', attempt_count = attempt_count + 1, \
           lease_owner = ?, lease_expires_at = ?, updated_at = ? \
         WHERE id IN (SELECT id FROM candidates) AND attempt_count < ? AND ( \
           (status = 'scheduled' AND due_at <= ? AND available_at <= ?) OR \
           (status = 'processing' AND lease_expires_at <= ?) \
         ) RETURNING id, workflow_id, wait_condition_id, due_at, attempt_count",
    )
    .bind(TIMER_RETRY_POLICY.max_attempts)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(limit)
    .bind(worker_id)
    .bind(lease_expires_at)
    .bind(now)
    .bind(TIMER_RETRY_POLICY.max_attempts)
    .bind(now)
    .bind(now)
    .bind(now)
    .fetch_all(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let mut timers = Vec::with_capacity(rows.len());
    for row in rows {
        let wait_condition_id: String = row
            .try_get("wait_condition_id")
            .map_err(database::database_error)?;
        let condition = sqlx::query(
            "SELECT payload_json, correlation_id, causation_id FROM workflow_wait_conditions \
             WHERE id = ? AND status = 'pending'",
        )
        .bind(&wait_condition_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        let payload_json: String = condition
            .try_get("payload_json")
            .map_err(database::database_error)?;
        timers.push(ClaimedWorkflowTimer {
            id: row.try_get("id").map_err(database::database_error)?,
            workflow_id: row
                .try_get("workflow_id")
                .map_err(database::database_error)?,
            wait_condition_id,
            due_at: row.try_get("due_at").map_err(database::database_error)?,
            payload: serde_json::from_str(&payload_json)
                .map_err(|error| format!("Timer payload 无效：{error}"))?,
            correlation_id: condition
                .try_get("correlation_id")
                .map_err(database::database_error)?,
            causation_id: condition
                .try_get("causation_id")
                .map_err(database::database_error)?,
            attempt_count: row
                .try_get("attempt_count")
                .map_err(database::database_error)?,
        });
    }
    timers.sort_by_key(|timer| timer.due_at);
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(timers)
}

async fn fire_claimed_timer(
    connection: &SqlitePool,
    worker_id: &str,
    timer: &ClaimedWorkflowTimer,
    fired_at: i64,
) -> Result<bool, String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let owns_timer = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM workflow_timers timer \
         INNER JOIN workflow_wait_conditions condition ON condition.id = timer.wait_condition_id \
         WHERE timer.id = ? AND timer.status = 'processing' AND timer.lease_owner = ? \
         AND condition.status = 'pending'",
    )
    .bind(&timer.id)
    .bind(worker_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if owns_timer != 1 {
        transaction
            .rollback()
            .await
            .map_err(database::database_error)?;
        return Ok(false);
    }
    let event_id = format!("workflow-timer-fired-{}", timer.id);
    let outbox_id = format!("workflow-timer-fired-outbox-{}", timer.id);
    let event_payload = json!({
        "timerId": timer.id,
        "waitConditionId": timer.wait_condition_id,
        "workflowId": timer.workflow_id,
        "dueAt": timer.due_at,
        "firedAt": fired_at,
        "payload": timer.payload,
    });
    record_with_outbox(
        &mut transaction,
        NewDomainEvent {
            event_id: &event_id,
            outbox_id: &outbox_id,
            event_type: "workflow.timer_fired",
            aggregate_type: "workflow",
            aggregate_id: &timer.workflow_id,
            payload: &event_payload,
            actor_id: "rust-workflow-timer",
            source: "rust_timer",
            workspace_id: None,
            deduplication_key: &event_id,
            security_scope: None,
            correlation_id: &timer.correlation_id,
            causation_id: timer.causation_id.as_deref(),
            occurred_at: fired_at,
        },
    )
    .await?;
    let condition = sqlx::query(
        "UPDATE workflow_wait_conditions SET status = 'satisfied', resume_payload_json = ?, \
         updated_at = ?, satisfied_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(event_payload.to_string())
    .bind(fired_at)
    .bind(fired_at)
    .bind(&timer.wait_condition_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let fired = sqlx::query(
        "UPDATE workflow_timers SET status = 'fired', lease_owner = NULL, lease_expires_at = NULL, \
         last_error = NULL, fired_at = ?, updated_at = ? \
         WHERE id = ? AND status = 'processing' AND lease_owner = ?",
    )
    .bind(fired_at)
    .bind(fired_at)
    .bind(&timer.id)
    .bind(worker_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if condition.rows_affected() != 1 || fired.rows_affected() != 1 {
        return Err("Timer lease 或等待条件在触发时发生变化。".to_string());
    }
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(true)
}

async fn reschedule_failed_timer(
    connection: &SqlitePool,
    worker_id: &str,
    timer: &ClaimedWorkflowTimer,
    error: &str,
    now: i64,
) -> Result<(), String> {
    let error = error.chars().take(2_000).collect::<String>();
    if TIMER_RETRY_POLICY.exhausted(timer.attempt_count) {
        let mut transaction = connection.begin().await.map_err(database::database_error)?;
        let updated = sqlx::query(
            "UPDATE workflow_timers SET status = 'dead_lettered', lease_owner = NULL, \
             lease_expires_at = NULL, last_error = ?, updated_at = ? \
             WHERE id = ? AND status = 'processing' AND lease_owner = ?",
        )
        .bind(&error)
        .bind(now)
        .bind(&timer.id)
        .bind(worker_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        if updated.rows_affected() == 1 {
            sqlx::query(
                "UPDATE workflow_wait_conditions SET status = 'failed', updated_at = ? \
                 WHERE id = ? AND status = 'pending'",
            )
            .bind(now)
            .bind(&timer.wait_condition_id)
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
        }
        return transaction.commit().await.map_err(database::database_error);
    }
    let delay = TIMER_RETRY_POLICY.delay_ms(timer.attempt_count);
    sqlx::query(
        "UPDATE workflow_timers SET status = 'scheduled', available_at = ?, lease_owner = NULL, \
         lease_expires_at = NULL, last_error = ?, updated_at = ? \
         WHERE id = ? AND status = 'processing' AND lease_owner = ?",
    )
    .bind(now.saturating_add(delay))
    .bind(error)
    .bind(now)
    .bind(&timer.id)
    .bind(worker_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

async fn dead_letter_exhausted_timers(connection: &SqlitePool, now: i64) -> Result<u64, String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let rows = sqlx::query(
        "SELECT id, wait_condition_id FROM workflow_timers WHERE status = 'processing' \
         AND lease_expires_at <= ? AND attempt_count >= ?",
    )
    .bind(now)
    .bind(TIMER_RETRY_POLICY.max_attempts)
    .fetch_all(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    let mut dead_lettered = 0;
    for row in &rows {
        let id: String = row.try_get("id").map_err(database::database_error)?;
        let wait_condition_id: String = row
            .try_get("wait_condition_id")
            .map_err(database::database_error)?;
        let updated = sqlx::query(
            "UPDATE workflow_timers SET status = 'dead_lettered', lease_owner = NULL, \
             lease_expires_at = NULL, last_error = COALESCE(last_error, 'Timer lease repeated expired'), \
             updated_at = ? WHERE id = ? AND status = 'processing' AND lease_expires_at <= ?",
        )
        .bind(now)
        .bind(id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        if updated.rows_affected() == 1 {
            dead_lettered += 1;
            sqlx::query(
                "UPDATE workflow_wait_conditions SET status = 'failed', updated_at = ? \
                 WHERE id = ? AND status = 'pending'",
            )
            .bind(now)
            .bind(wait_condition_id)
            .execute(&mut *transaction)
            .await
            .map_err(database::database_error)?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(dead_lettered)
}

fn require_non_empty(value: &str, name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{name} 不能为空。"));
    }
    Ok(())
}

fn new_id(prefix: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "{prefix}-{}-{}-{}",
        std::process::id(),
        now_millis(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool(name: &str) -> (std::path::PathBuf, std::sync::Arc<SqlitePool>) {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-{name}-{}-{}.db",
            std::process::id(),
            now_millis()
        ));
        let pool = database::get_pool_for_path(&path, true)
            .await
            .expect("open test database");
        database::DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("migrate test database");
        (path, pool)
    }

    async fn cleanup(path: std::path::PathBuf, pool: std::sync::Arc<SqlitePool>) {
        drop(pool);
        database::close_pool(&path).await.expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn timer_metrics_report_backlog_retries_dead_letters_and_lag() {
        let (path, pool) = test_pool("workflow-timer-metrics").await;
        let mut timers = Vec::new();
        for index in 0..3 {
            let workflow_id = format!("workflow-metrics-{index}");
            let correlation_id = format!("correlation-{index}");
            let payload = json!({ "index": index });
            timers.push(
                schedule_workflow_timer_in_pool(
                    pool.as_ref(),
                    NewWorkflowTimer {
                        workflow_id: &workflow_id,
                        deduplication_key: "wake",
                        due_at: 100 + index,
                        payload: &payload,
                        correlation_id: &correlation_id,
                        causation_id: None,
                    },
                    1,
                )
                .await
                .expect("schedule metric timer"),
            );
        }
        sqlx::query("UPDATE workflow_timers SET last_error = 'retry' WHERE id = ?")
            .bind(&timers[0].timer_id)
            .execute(pool.as_ref())
            .await
            .expect("mark retry");
        sqlx::query("UPDATE workflow_timers SET status = 'processing' WHERE id = ?")
            .bind(&timers[1].timer_id)
            .execute(pool.as_ref())
            .await
            .expect("mark processing");
        sqlx::query("UPDATE workflow_timers SET status = 'dead_lettered' WHERE id = ?")
            .bind(&timers[2].timer_id)
            .execute(pool.as_ref())
            .await
            .expect("mark dead letter");

        let metrics = load_timer_metrics(pool.as_ref(), 500)
            .await
            .expect("load timer metrics");
        assert_eq!(metrics.scheduled_count, 1);
        assert_eq!(metrics.processing_count, 1);
        assert_eq!(metrics.retry_count, 1);
        assert_eq!(metrics.due_count, 1);
        assert_eq!(metrics.dead_letter_count, 1);
        assert_eq!(metrics.max_lag_ms, 400);
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn timer_schedule_is_idempotent_and_fires_event_once() {
        let (path, pool) = test_pool("workflow-timer-once").await;
        let first = schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-1",
                deduplication_key: "wake-once",
                due_at: 1_000,
                payload: &json!({ "input": "resume" }),
                correlation_id: "correlation-1",
                causation_id: Some("cause-1"),
            },
            100,
        )
        .await
        .expect("schedule timer");
        let duplicate = schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-1",
                deduplication_key: "wake-once",
                due_at: 1_000,
                payload: &json!({ "input": "resume" }),
                correlation_id: "correlation-1",
                causation_id: Some("cause-1"),
            },
            200,
        )
        .await
        .expect("repeat same schedule");
        assert_eq!(duplicate, first);
        assert!(claim_due_timers(pool.as_ref(), "worker-1", 999, 30_000, 10)
            .await
            .expect("claim before due")
            .is_empty());
        let timers = claim_due_timers(pool.as_ref(), "worker-1", 1_000, 30_000, 10)
            .await
            .expect("claim due timer");
        assert_eq!(timers.len(), 1);
        assert!(
            fire_claimed_timer(pool.as_ref(), "worker-1", &timers[0], 1_001)
                .await
                .expect("fire timer")
        );
        assert!(
            claim_due_timers(pool.as_ref(), "worker-2", 100_000, 30_000, 10)
                .await
                .expect("claim after fired")
                .is_empty()
        );

        let status: (String, String) = sqlx::query_as(
            "SELECT timer.status, condition.status FROM workflow_timers timer \
             INNER JOIN workflow_wait_conditions condition ON condition.id = timer.wait_condition_id \
             WHERE timer.id = ?",
        )
        .bind(&first.timer_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("timer status");
        assert_eq!(status, ("fired".to_string(), "satisfied".to_string()));
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM domain_events WHERE event_type = 'workflow.timer_fired' \
             AND aggregate_id = 'workflow-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("event count");
        let outbox_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM outbox_messages WHERE topic = 'workflow.timer_fired'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("outbox count");
        assert_eq!((event_count, outbox_count), (1, 1));
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn expired_lease_is_recovered_after_restart_without_stealing_active_work() {
        let (path, pool) = test_pool("workflow-timer-restart").await;
        schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-restart",
                deduplication_key: "wake-after-restart",
                due_at: 500,
                payload: &json!({}),
                correlation_id: "correlation-restart",
                causation_id: None,
            },
            100,
        )
        .await
        .expect("schedule timer");
        let first = claim_due_timers(pool.as_ref(), "old-process", 500, 2_000, 10)
            .await
            .expect("old process claims timer");
        assert_eq!(first.len(), 1);
        assert!(
            claim_due_timers(pool.as_ref(), "new-process", 2_499, 2_000, 10)
                .await
                .expect("active lease remains owned")
                .is_empty()
        );
        drop(pool);
        database::close_pool(&path)
            .await
            .expect("close database for restart");
        let pool = database::get_pool_for_path(&path, false)
            .await
            .expect("reopen database after restart");
        let recovered = claim_due_timers(pool.as_ref(), "new-process", 2_500, 2_000, 10)
            .await
            .expect("expired lease recovered");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].attempt_count, 2);
        assert!(
            fire_claimed_timer(pool.as_ref(), "new-process", &recovered[0], 2_501)
                .await
                .expect("recovered timer fires")
        );
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM domain_events WHERE aggregate_id = 'workflow-restart'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("event count");
        assert_eq!(event_count, 1);
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn overdue_timer_catches_up_after_sleep_or_wall_clock_jump() {
        let (path, pool) = test_pool("workflow-timer-clock").await;
        schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-clock",
                deduplication_key: "absolute-utc-deadline",
                due_at: 10_000,
                payload: &json!({}),
                correlation_id: "correlation-clock",
                causation_id: None,
            },
            1_000,
        )
        .await
        .expect("schedule timer");
        assert!(claim_due_timers(pool.as_ref(), "worker", 9_000, 30_000, 10)
            .await
            .expect("not due after backward clock change")
            .is_empty());
        let overdue = claim_due_timers(pool.as_ref(), "worker", 90_000, 30_000, 10)
            .await
            .expect("catch up after sleep");
        assert_eq!(overdue.len(), 1);
        assert_eq!(overdue[0].due_at, 10_000);
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn cancellation_wins_against_a_claimed_timer() {
        let (path, pool) = test_pool("workflow-timer-cancel").await;
        let scheduled = schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-cancel",
                deduplication_key: "cancel-me",
                due_at: 100,
                payload: &json!({}),
                correlation_id: "correlation-cancel",
                causation_id: None,
            },
            10,
        )
        .await
        .expect("schedule timer");
        let claimed = claim_due_timers(pool.as_ref(), "worker", 100, 30_000, 10)
            .await
            .expect("claim timer");
        cancel_workflow_timer_in_pool(pool.as_ref(), &scheduled.wait_condition_id, 101)
            .await
            .expect("cancel timer");
        assert!(
            !fire_claimed_timer(pool.as_ref(), "worker", &claimed[0], 102)
                .await
                .expect("cancelled timer is not fired")
        );
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM domain_events WHERE aggregate_id = 'workflow-cancel'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("event count");
        assert_eq!(event_count, 0);
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn failed_delivery_is_persistently_rescheduled_then_dead_lettered() {
        let (path, pool) = test_pool("workflow-timer-retry").await;
        let scheduled = schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-retry",
                deduplication_key: "retry-me",
                due_at: 100,
                payload: &json!({}),
                correlation_id: "correlation-retry",
                causation_id: None,
            },
            10,
        )
        .await
        .expect("schedule timer");
        let first = claim_due_timers(pool.as_ref(), "worker", 100, 30_000, 10)
            .await
            .expect("claim timer")
            .remove(0);
        reschedule_failed_timer(pool.as_ref(), "worker", &first, "temporary", 101)
            .await
            .expect("reschedule timer");
        let retry_at: i64 =
            sqlx::query_scalar("SELECT available_at FROM workflow_timers WHERE id = ?")
                .bind(&scheduled.timer_id)
                .fetch_one(pool.as_ref())
                .await
                .expect("retry timestamp");
        assert_eq!(retry_at, 5_101);
        assert!(claim_due_timers(pool.as_ref(), "worker", 5_100, 30_000, 10)
            .await
            .expect("wait for retry")
            .is_empty());

        sqlx::query(
            "UPDATE workflow_timers SET status = 'processing', attempt_count = ?, \
             lease_owner = 'worker', lease_expires_at = 10_000 WHERE id = ?",
        )
        .bind(TIMER_RETRY_POLICY.max_attempts)
        .bind(&scheduled.timer_id)
        .execute(pool.as_ref())
        .await
        .expect("simulate exhausted attempts");
        let exhausted = ClaimedWorkflowTimer {
            attempt_count: TIMER_RETRY_POLICY.max_attempts,
            ..first
        };
        reschedule_failed_timer(pool.as_ref(), "worker", &exhausted, "permanent", 6_000)
            .await
            .expect("dead letter timer");
        let statuses: (String, String) = sqlx::query_as(
            "SELECT timer.status, condition.status FROM workflow_timers timer \
             INNER JOIN workflow_wait_conditions condition ON condition.id = timer.wait_condition_id \
             WHERE timer.id = ?",
        )
        .bind(&scheduled.timer_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("dead letter status");
        assert_eq!(
            statuses,
            ("dead_lettered".to_string(), "failed".to_string())
        );
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn deduplication_key_rejects_a_different_schedule() {
        let (path, pool) = test_pool("workflow-timer-dedup").await;
        schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-dedup",
                deduplication_key: "same-key",
                due_at: 100,
                payload: &json!({ "value": 1 }),
                correlation_id: "correlation-dedup",
                causation_id: None,
            },
            10,
        )
        .await
        .expect("schedule timer");
        let error = schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-dedup",
                deduplication_key: "same-key",
                due_at: 101,
                payload: &json!({ "value": 2 }),
                correlation_id: "correlation-dedup",
                causation_id: None,
            },
            11,
        )
        .await
        .expect_err("conflicting schedule must fail");
        assert!(error.contains("去重键"));
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn startup_scan_dead_letters_an_exhausted_expired_lease() {
        let (path, pool) = test_pool("workflow-timer-startup-dead-letter").await;
        let scheduled = schedule_workflow_timer_in_pool(
            pool.as_ref(),
            NewWorkflowTimer {
                workflow_id: "workflow-startup",
                deduplication_key: "exhausted",
                due_at: 100,
                payload: &json!({}),
                correlation_id: "correlation-startup",
                causation_id: None,
            },
            10,
        )
        .await
        .expect("schedule timer");
        sqlx::query(
            "UPDATE workflow_timers SET status = 'processing', attempt_count = ?, \
             lease_owner = 'dead-process', lease_expires_at = 200 WHERE id = ?",
        )
        .bind(TIMER_RETRY_POLICY.max_attempts)
        .bind(&scheduled.timer_id)
        .execute(pool.as_ref())
        .await
        .expect("simulate exhausted process");
        assert_eq!(
            dead_letter_exhausted_timers(pool.as_ref(), 200)
                .await
                .expect("recover exhausted timer"),
            1
        );
        let statuses: (String, String) = sqlx::query_as(
            "SELECT timer.status, condition.status FROM workflow_timers timer \
             INNER JOIN workflow_wait_conditions condition ON condition.id = timer.wait_condition_id \
             WHERE timer.id = ?",
        )
        .bind(&scheduled.timer_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("recovered statuses");
        assert_eq!(
            statuses,
            ("dead_lettered".to_string(), "failed".to_string())
        );
        cleanup(path, pool).await;
    }

    #[tokio::test]
    async fn data_migration_quiesce_aborts_scheduler_and_preserves_its_directory() {
        struct DropSignal(std::sync::Arc<AtomicBool>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let state = DurableTimerSchedulerState::default();
        *state.data_directory.lock().await = Some("C:/source".to_string());
        let stopped = std::sync::Arc::new(AtomicBool::new(false));
        let signal = std::sync::Arc::clone(&stopped);
        let task = tokio::spawn(async move {
            let _signal = DropSignal(signal);
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        *state.task.lock().await = Some(task);

        let snapshot = quiesce_for_data_migration(&state).await;
        assert!(snapshot.was_running);
        assert_eq!(snapshot.data_directory.as_deref(), Some("C:/source"));
        assert!(stopped.load(Ordering::SeqCst));
        assert!(state.migration_paused.load(Ordering::SeqCst));
        assert!(state.task.lock().await.is_none());
    }
}
