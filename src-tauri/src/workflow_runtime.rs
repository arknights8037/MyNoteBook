use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    sync::{Mutex, RwLock},
    task::JoinHandle,
    time::{Duration, MissedTickBehavior},
};

use crate::database;

const WORKFLOW_SCANNER_STATUS_EVENT: &str = "workflow-scanner://status";

pub(crate) struct WorkflowScannerProjectionState {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Default for WorkflowScannerProjectionState {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkflowScannerStatus {
    Stopped,
    Running,
    Paused,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowScannerSnapshot {
    status: WorkflowScannerStatus,
    last_tick_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error: Option<String>,
    resumed_event_wait_count: u64,
    resumed_satisfied_wait_count: u64,
    automation_enqueued_count: u64,
    signal_enqueued_count: u64,
    action_recovered_count: u64,
}

impl Default for WorkflowScannerSnapshot {
    fn default() -> Self {
        Self {
            status: WorkflowScannerStatus::Stopped,
            last_tick_at: None,
            last_success_at: None,
            last_error: None,
            resumed_event_wait_count: 0,
            resumed_satisfied_wait_count: 0,
            automation_enqueued_count: 0,
            signal_enqueued_count: 0,
            action_recovered_count: 0,
        }
    }
}

#[tauri::command]
pub(crate) async fn get_workflow_scanner_snapshot(
    app: AppHandle,
    core_state: State<'_, crate::core_supervisor::HeadlessCoreSupervisorState>,
) -> Result<WorkflowScannerSnapshot, String> {
    let endpoint = crate::core_supervisor::active_endpoint(&app, core_state.inner()).await?;
    crate::core_server::get_workflow_scanner_snapshot(&endpoint).await
}

pub(crate) async fn ensure_snapshot_projection(
    app: &AppHandle,
    state: &WorkflowScannerProjectionState,
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
        run_scanner_snapshot_projection(app).await;
    }));
    Ok(())
}

async fn run_scanner_snapshot_projection(app: AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let core_state = app.state::<crate::core_supervisor::HeadlessCoreSupervisorState>();
        let snapshot = match crate::core_supervisor::active_endpoint(&app, core_state.inner()).await
        {
            Ok(endpoint) => crate::core_server::get_workflow_scanner_snapshot(&endpoint).await,
            Err(error) => Err(error),
        };
        match snapshot {
            Ok(snapshot) => {
                let _ = app.emit(WORKFLOW_SCANNER_STATUS_EVENT, snapshot);
            }
            Err(error) => {
                let _ = app.emit(
                    WORKFLOW_SCANNER_STATUS_EVENT,
                    WorkflowScannerSnapshot::degraded(error),
                );
            }
        }
    }
}

impl WorkflowScannerSnapshot {
    fn degraded(error: String) -> Self {
        Self {
            status: WorkflowScannerStatus::Degraded,
            last_tick_at: Some(crate::reliability::now_millis()),
            last_error: Some(error.chars().take(1_000).collect()),
            ..Self::default()
        }
    }
}

pub(crate) struct CoreWorkflowScannerState {
    task: Mutex<Option<JoinHandle<()>>>,
    database_path: Mutex<Option<PathBuf>>,
    snapshot: Arc<RwLock<WorkflowScannerSnapshot>>,
}

impl Default for CoreWorkflowScannerState {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
            database_path: Mutex::new(None),
            snapshot: Arc::new(RwLock::new(WorkflowScannerSnapshot::default())),
        }
    }
}

pub(crate) struct CoreWorkflowScannerMigrationSnapshot {
    pub(crate) was_running: bool,
}

impl CoreWorkflowScannerState {
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
        update_scanner_snapshot(&self.snapshot, |snapshot| {
            snapshot.status = WorkflowScannerStatus::Running;
            snapshot.last_error = None;
        })
        .await;
        let snapshot = Arc::clone(&self.snapshot);
        *task = Some(tokio::spawn(async move {
            run_workflow_scanner(database_path, snapshot).await;
        }));
        Ok(())
    }

    pub(crate) async fn snapshot(&self) -> WorkflowScannerSnapshot {
        self.snapshot.read().await.clone()
    }

    pub(crate) async fn quiesce(&self) -> CoreWorkflowScannerMigrationSnapshot {
        let existing = self.task.lock().await.take();
        let was_running = existing.as_ref().is_some_and(|task| !task.is_finished());
        if let Some(existing) = existing {
            existing.abort();
            let _ = existing.await;
        }
        self.snapshot.write().await.status = WorkflowScannerStatus::Paused;
        CoreWorkflowScannerMigrationSnapshot { was_running }
    }

    pub(crate) async fn quiesce_if_directory(&self, directory: &Path) {
        let database_path = directory.join(database::DATABASE_FILENAME);
        let matches_directory = self.database_path.lock().await.as_ref() == Some(&database_path);
        if matches_directory {
            self.quiesce().await;
        }
    }

    pub(crate) async fn shutdown(&self) {
        let existing = self.task.lock().await.take();
        if let Some(existing) = existing {
            existing.abort();
            let _ = existing.await;
        }
        self.snapshot.write().await.status = WorkflowScannerStatus::Stopped;
    }
}

async fn run_workflow_scanner(
    database_path: PathBuf,
    snapshot: Arc<RwLock<WorkflowScannerSnapshot>>,
) {
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let now = crate::reliability::now_millis();
        update_scanner_snapshot(&snapshot, |snapshot| {
            snapshot.status = WorkflowScannerStatus::Running;
            snapshot.last_tick_at = Some(now);
        })
        .await;
        let connection = match database::get_pool_for_path(&database_path, false).await {
            Ok(connection) => connection,
            Err(error) => {
                record_scanner_error(&snapshot, now, error).await;
                continue;
            }
        };
        let event_waits = consume_event_waits(connection.as_ref(), now).await;
        let satisfied_waits = resume_satisfied_waits(connection.as_ref(), now).await;
        let automation_runs =
            crate::automation_runtime::enqueue_due_runs(connection.as_ref()).await;
        let signal_runs = crate::signal_runtime::enqueue_events(connection.as_ref()).await;
        let recovered_actions =
            crate::action_gateway::recover_expired_actions(connection.as_ref(), now).await;
        let mut errors = Vec::new();
        let event_count = result_or_record(event_waits, "Workflow Event 等待扫描", &mut errors);
        let satisfied_count =
            result_or_record(satisfied_waits, "Workflow 已满足等待扫描", &mut errors);
        let automation_count =
            result_or_record(automation_runs, "Automation 到期入队扫描", &mut errors) as u64;
        let signal_count =
            result_or_record(signal_runs, "Signal Event 入队扫描", &mut errors) as u64;
        let action_count =
            result_or_record(recovered_actions, "Action 过期 lease 恢复", &mut errors);
        update_scanner_snapshot(&snapshot, |snapshot| {
            snapshot.status = if errors.is_empty() {
                WorkflowScannerStatus::Running
            } else {
                WorkflowScannerStatus::Degraded
            };
            if errors.is_empty() {
                snapshot.last_success_at = Some(now);
            }
            snapshot.last_error = (!errors.is_empty())
                .then(|| errors.join("；").chars().take(2_000).collect::<String>());
            snapshot.resumed_event_wait_count = snapshot
                .resumed_event_wait_count
                .saturating_add(event_count);
            snapshot.resumed_satisfied_wait_count = snapshot
                .resumed_satisfied_wait_count
                .saturating_add(satisfied_count);
            snapshot.automation_enqueued_count = snapshot
                .automation_enqueued_count
                .saturating_add(automation_count);
            snapshot.signal_enqueued_count =
                snapshot.signal_enqueued_count.saturating_add(signal_count);
            snapshot.action_recovered_count =
                snapshot.action_recovered_count.saturating_add(action_count);
        })
        .await;
    }
}

fn result_or_record<T: Default>(
    result: Result<T, String>,
    operation: &str,
    errors: &mut Vec<String>,
) -> T {
    match result {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("{operation}失败：{error}"));
            T::default()
        }
    }
}

async fn update_scanner_snapshot(
    snapshot: &RwLock<WorkflowScannerSnapshot>,
    update: impl FnOnce(&mut WorkflowScannerSnapshot),
) {
    let mut snapshot = snapshot.write().await;
    update(&mut snapshot);
}

async fn record_scanner_error(snapshot: &RwLock<WorkflowScannerSnapshot>, now: i64, error: String) {
    update_scanner_snapshot(snapshot, |snapshot| {
        snapshot.status = WorkflowScannerStatus::Degraded;
        snapshot.last_tick_at = Some(now);
        snapshot.last_error = Some(error.chars().take(2_000).collect());
    })
    .await;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowBinding {
    pub(crate) work_item_id: String,
    pub(crate) workflow_id: String,
    pub(crate) event_id: String,
    pub(crate) correlation_id: String,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct SuspendRequest<'a> {
    pub(crate) condition_kind: &'a str,
    pub(crate) deduplication_key: &'a str,
    pub(crate) payload: &'a Value,
    pub(crate) due_at: Option<i64>,
}

pub(crate) struct NewWorkflow<'a> {
    pub(crate) work_item_id: &'a str,
    pub(crate) workflow_id: &'a str,
    pub(crate) event_id: &'a str,
    pub(crate) source_type: &'a str,
    pub(crate) classification: &'a str,
    pub(crate) payload: &'a Value,
    pub(crate) correlation_id: &'a str,
    pub(crate) causation_id: Option<&'a str>,
}

pub(crate) async fn create_workflow_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow: NewWorkflow<'_>,
    now: i64,
) -> Result<WorkflowBinding, String> {
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_work_items \
         (id, event_id, source_type, classification, status, payload_json, correlation_id, \
          causation_id, deduplication_key, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
    )
    .bind(workflow.work_item_id)
    .bind(workflow.event_id)
    .bind(workflow.source_type)
    .bind(workflow.classification)
    .bind(workflow.payload.to_string())
    .bind(workflow.correlation_id)
    .bind(workflow.causation_id)
    .bind(format!("work-item:{}", workflow.event_id))
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_instances \
         (id, work_item_id, workflow_type, state, correlation_id, causation_id, created_at, updated_at) \
         VALUES (?, ?, 'agent', 'READY', ?, ?, ?, ?)",
    )
    .bind(workflow.workflow_id)
    .bind(workflow.work_item_id)
    .bind(workflow.correlation_id)
    .bind(workflow.causation_id)
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(WorkflowBinding {
        work_item_id: workflow.work_item_id.to_string(),
        workflow_id: workflow.workflow_id.to_string(),
        event_id: workflow.event_id.to_string(),
        correlation_id: workflow.correlation_id.to_string(),
    })
}

#[allow(dead_code)]
pub(crate) async fn start_run(
    connection: &SqlitePool,
    binding: &WorkflowBinding,
    run_id: &str,
    attempt_number: i64,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    start_run_in_transaction(&mut transaction, binding, run_id, attempt_number, now).await?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn start_run_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    binding: &WorkflowBinding,
    run_id: &str,
    attempt_number: i64,
    now: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO workflow_run_attempts \
         (id, workflow_id, run_id, attempt_number, status, causation_event_id, started_at) \
         VALUES (?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(format!("workflow-attempt-{run_id}"))
    .bind(&binding.workflow_id)
    .bind(run_id)
    .bind(attempt_number)
    .bind(&binding.event_id)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'RUNNING', current_run_id = ?, \
         current_wait_condition_id = NULL, error = NULL, updated_at = ?, completed_at = NULL \
         WHERE id = ? AND state IN ('READY', 'RETRY_SCHEDULED')",
    )
    .bind(run_id)
    .bind(now)
    .bind(&binding.workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许启动新的 Run。".to_string());
    }
    sqlx::query("UPDATE workflow_work_items SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&binding.work_item_id)
        .execute(&mut **transaction)
        .await
        .map_err(database::database_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) async fn mark_retry_scheduled(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: Option<&str>,
    error: &str,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    mark_retry_scheduled_in_transaction(&mut transaction, workflow_id, run_id, error, now).await?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn mark_retry_scheduled_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    run_id: Option<&str>,
    error: &str,
    now: i64,
) -> Result<(), String> {
    finish_attempt_in_transaction(transaction, workflow_id, run_id, "failed", Some(error), now)
        .await?;
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'RETRY_SCHEDULED', current_run_id = NULL, \
         error = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(truncate(error))
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许进入重试状态。".to_string());
    }
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'queued', updated_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) async fn mark_completed(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: &str,
    output: &Value,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    mark_completed_in_transaction(&mut transaction, workflow_id, run_id, output, now).await?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn mark_completed_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    run_id: &str,
    output: &Value,
    now: i64,
) -> Result<(), String> {
    finish_attempt_in_transaction(
        transaction,
        workflow_id,
        Some(run_id),
        "completed",
        None,
        now,
    )
    .await?;
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'COMPLETED', current_run_id = NULL, \
         output_json = ?, error = NULL, updated_at = ?, completed_at = ? \
         WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(output.to_string())
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许完成当前 Run。".to_string());
    }
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'completed', updated_at = ?, completed_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) async fn mark_waiting_approval(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: &str,
    payload: &Value,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    mark_waiting_approval_in_transaction(&mut transaction, workflow_id, run_id, payload, now)
        .await?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn mark_waiting_approval_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    run_id: &str,
    payload: &Value,
    now: i64,
) -> Result<(), String> {
    finish_attempt_in_transaction(
        transaction,
        workflow_id,
        Some(run_id),
        "completed",
        None,
        now,
    )
    .await?;
    let wait_id = format!("workflow-wait-approval-{workflow_id}-{run_id}");
    let correlation_id: String =
        sqlx::query_scalar("SELECT correlation_id FROM workflow_instances WHERE id = ?")
            .bind(workflow_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(database::database_error)?;
    let updated = sqlx::query(
        "INSERT OR IGNORE INTO workflow_wait_conditions \
         (id, workflow_id, deduplication_key, condition_kind, status, correlation_id, \
          causation_id, payload_json, created_at, updated_at) \
         VALUES (?, ?, ?, 'approval', 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&wait_id)
    .bind(workflow_id)
    .bind(format!("mutation-approval:{run_id}"))
    .bind(correlation_id)
    .bind(run_id)
    .bind(payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许等待审批。".to_string());
    }
    let workflow_updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'WAITING_APPROVAL', current_run_id = NULL, \
         current_wait_condition_id = ?, output_json = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(&wait_id)
    .bind(payload.to_string())
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if workflow_updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许等待审批。".to_string());
    }
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'waiting', updated_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) async fn suspend_run(
    connection: &SqlitePool,
    binding: &WorkflowBinding,
    run_id: &str,
    request: SuspendRequest<'_>,
    now: i64,
) -> Result<String, String> {
    let state = match request.condition_kind {
        "event" => "WAITING_EVENT",
        "timer" => "WAITING_TIMER",
        "human" => "WAITING_HUMAN",
        "approval" => "WAITING_APPROVAL",
        _ => return Err("SuspendRequest 等待类型无效。".to_string()),
    };
    if request.deduplication_key.trim().is_empty() {
        return Err("SuspendRequest 去重键不能为空。".to_string());
    }
    if request.condition_kind == "timer" && request.due_at.is_none() {
        return Err("Timer SuspendRequest 缺少 dueAt。".to_string());
    }
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    finish_attempt_in_transaction(
        &mut transaction,
        &binding.workflow_id,
        Some(run_id),
        "completed",
        None,
        now,
    )
    .await?;
    let wait_id = format!(
        "workflow-wait-suspend-{}-{}",
        binding.workflow_id, request.deduplication_key
    );
    sqlx::query(
        "INSERT OR IGNORE INTO workflow_wait_conditions \
         (id, workflow_id, deduplication_key, condition_kind, status, correlation_id, \
          causation_id, payload_json, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&wait_id)
    .bind(&binding.workflow_id)
    .bind(request.deduplication_key)
    .bind(request.condition_kind)
    .bind(&binding.correlation_id)
    .bind(&binding.event_id)
    .bind(request.payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if let Some(due_at) = request.due_at {
        if due_at < 0 {
            return Err("Timer SuspendRequest 的 dueAt 无效。".to_string());
        }
        sqlx::query(
            "INSERT OR IGNORE INTO workflow_timers \
             (id, workflow_id, wait_condition_id, due_at, available_at, status, attempt_count, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)",
        )
        .bind(format!("workflow-timer-suspend-{wait_id}"))
        .bind(&binding.workflow_id)
        .bind(&wait_id)
        .bind(due_at)
        .bind(due_at)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    }
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = ?, current_run_id = NULL, \
         current_wait_condition_id = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'",
    )
    .bind(state)
    .bind(&wait_id)
    .bind(now)
    .bind(&binding.workflow_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许挂起当前 Run。".to_string());
    }
    sqlx::query("UPDATE workflow_work_items SET status = 'waiting', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&binding.work_item_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(wait_id)
}

pub(crate) async fn consume_event_waits(connection: &SqlitePool, now: i64) -> Result<u64, String> {
    let waits = sqlx::query(
        "SELECT condition.id, condition.workflow_id, condition.payload_json, \
                condition.correlation_id, condition.created_at \
         FROM workflow_wait_conditions condition \
         INNER JOIN workflow_instances workflow ON workflow.id = condition.workflow_id \
         WHERE condition.condition_kind = 'event' AND condition.status = 'pending' \
           AND workflow.state = 'WAITING_EVENT' ORDER BY condition.created_at ASC LIMIT 50",
    )
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?;
    let mut resumed = 0;
    for wait in waits {
        let payload = parse_json_column(&wait, "payload_json")?;
        let Some(event_type) = payload.get("eventType").and_then(Value::as_str) else {
            continue;
        };
        let correlation_id: String = wait
            .try_get("correlation_id")
            .map_err(database::database_error)?;
        let created_at: i64 = wait
            .try_get("created_at")
            .map_err(database::database_error)?;
        let event = sqlx::query(
            "SELECT id, event_type, source, occurred_at, actor_id, workspace_id, correlation_id, \
                    causation_id, deduplication_key, payload_json, security_scope_json \
             FROM domain_events WHERE event_type = ? AND correlation_id = ? AND occurred_at >= ? \
             ORDER BY occurred_at ASC LIMIT 1",
        )
        .bind(event_type)
        .bind(&correlation_id)
        .bind(created_at)
        .fetch_optional(connection)
        .await
        .map_err(database::database_error)?;
        let Some(event) = event else {
            continue;
        };
        let event_id: String = event.try_get("id").map_err(database::database_error)?;
        let resume_payload = json!({
            "version": 1,
            "eventId": event_id,
            "eventType": event.try_get::<String, _>("event_type").unwrap_or_default(),
            "source": event.try_get::<String, _>("source").unwrap_or_default(),
            "occurredAt": event.try_get::<i64, _>("occurred_at").unwrap_or(now),
            "actorId": event.try_get::<String, _>("actor_id").unwrap_or_default(),
            "workspaceId": event.try_get::<Option<String>, _>("workspace_id").unwrap_or(None),
            "correlationId": correlation_id,
            "causationId": event.try_get::<Option<String>, _>("causation_id").unwrap_or(None),
            "deduplicationKey": event.try_get::<Option<String>, _>("deduplication_key").unwrap_or(None),
            "payload": parse_json_column(&event, "payload_json")?,
            "securityScope": parse_json_column(&event, "security_scope_json")?
        });
        let wait_id: String = wait.try_get("id").map_err(database::database_error)?;
        let workflow_id: String = wait
            .try_get("workflow_id")
            .map_err(database::database_error)?;
        let mut transaction = connection.begin().await.map_err(database::database_error)?;
        let satisfied = sqlx::query(
            "UPDATE workflow_wait_conditions SET status = 'satisfied', resume_payload_json = ?, \
             satisfied_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(resume_payload.to_string())
        .bind(now)
        .bind(now)
        .bind(&wait_id)
        .execute(&mut *transaction)
        .await
        .map_err(database::database_error)?;
        if satisfied.rows_affected() == 1 {
            resume_workflow_in_transaction(
                &mut transaction,
                &workflow_id,
                &wait_id,
                &event_id,
                now,
            )
            .await?;
            resumed += 1;
        }
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
    }
    Ok(resumed)
}

pub(crate) async fn resume_satisfied_waits(
    connection: &SqlitePool,
    now: i64,
) -> Result<u64, String> {
    let waits = sqlx::query(
        "SELECT condition.id, condition.workflow_id, condition.resume_payload_json \
         FROM workflow_wait_conditions condition \
         INNER JOIN workflow_instances workflow ON workflow.id = condition.workflow_id \
         WHERE condition.status = 'satisfied' \
           AND workflow.current_wait_condition_id = condition.id \
           AND workflow.state IN ('WAITING_TIMER', 'WAITING_HUMAN', 'WAITING_APPROVAL') \
         ORDER BY condition.satisfied_at ASC LIMIT 50",
    )
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?;
    let mut resumed = 0;
    for wait in waits {
        let wait_id: String = wait.try_get("id").map_err(database::database_error)?;
        let workflow_id: String = wait
            .try_get("workflow_id")
            .map_err(database::database_error)?;
        let causation_id = wait
            .try_get::<Option<String>, _>("resume_payload_json")
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .and_then(|value| {
                value
                    .get("eventId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let mut transaction = connection.begin().await.map_err(database::database_error)?;
        resumed += resume_workflow_in_transaction(
            &mut transaction,
            &workflow_id,
            &wait_id,
            causation_id.as_deref().unwrap_or(&wait_id),
            now,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
    }
    Ok(resumed)
}

pub(crate) async fn resume_workflow_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    wait_id: &str,
    causation_id: &str,
    now: i64,
) -> Result<u64, String> {
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'READY', current_wait_condition_id = NULL, \
         causation_id = ?, updated_at = ? WHERE id = ? AND current_wait_condition_id = ? \
         AND state IN ('WAITING_EVENT', 'WAITING_TIMER', 'WAITING_HUMAN', 'WAITING_APPROVAL')",
    )
    .bind(causation_id)
    .bind(now)
    .bind(workflow_id)
    .bind(wait_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() == 1 {
        sqlx::query(
            "UPDATE workflow_work_items SET status = 'queued', causation_id = ?, updated_at = ? \
             WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
        )
        .bind(causation_id)
        .bind(now)
        .bind(workflow_id)
        .execute(&mut **transaction)
        .await
        .map_err(database::database_error)?;
    }
    Ok(updated.rows_affected())
}

#[allow(dead_code)]
pub(crate) async fn mark_failed(
    connection: &SqlitePool,
    workflow_id: &str,
    run_id: Option<&str>,
    error: &str,
    now: i64,
) -> Result<(), String> {
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    mark_failed_in_transaction(&mut transaction, workflow_id, run_id, error, now).await?;
    transaction.commit().await.map_err(database::database_error)
}

pub(crate) async fn mark_failed_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    run_id: Option<&str>,
    error: &str,
    now: i64,
) -> Result<(), String> {
    finish_attempt_in_transaction(transaction, workflow_id, run_id, "failed", Some(error), now)
        .await?;
    let updated = sqlx::query(
        "UPDATE workflow_instances SET state = 'FAILED', current_run_id = NULL, error = ?, \
         updated_at = ?, completed_at = ? WHERE id = ? AND state NOT IN ('COMPLETED', 'CANCELLED')",
    )
    .bind(truncate(error))
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Workflow 已不再允许进入失败终态。".to_string());
    }
    sqlx::query(
        "UPDATE workflow_work_items SET status = 'failed', updated_at = ?, completed_at = ? \
         WHERE id = (SELECT work_item_id FROM workflow_instances WHERE id = ?)",
    )
    .bind(now)
    .bind(now)
    .bind(workflow_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

async fn finish_attempt_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workflow_id: &str,
    run_id: Option<&str>,
    status: &str,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let Some(run_id) = run_id else {
        return Ok(());
    };
    sqlx::query(
        "UPDATE workflow_run_attempts SET status = ?, error = ?, completed_at = ? \
         WHERE workflow_id = ? AND run_id = ? AND status = 'running'",
    )
    .bind(status)
    .bind(error.map(truncate))
    .bind(now)
    .bind(workflow_id)
    .bind(run_id)
    .execute(&mut **transaction)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

fn truncate(value: &str) -> String {
    value.chars().take(2_000).collect()
}

fn parse_json_column(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Value, String> {
    let value: String = row.try_get(column).map_err(database::database_error)?;
    serde_json::from_str(&value).map_err(database::database_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain_events::{record_with_outbox, NewDomainEvent},
        reliability::now_millis,
    };

    async fn test_pool(label: &str) -> (std::path::PathBuf, std::sync::Arc<SqlitePool>) {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-workflow-{label}-{}-{}.db",
            std::process::id(),
            now_millis()
        ));
        let pool = database::get_pool_for_path(&path, true)
            .await
            .expect("open database");
        database::DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("migrate");
        (path, pool)
    }

    async fn cleanup(path: &std::path::Path, pool: std::sync::Arc<SqlitePool>) {
        drop(pool);
        database::close_pool(path).await.expect("close database");
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    async fn workflow_fixture(pool: &SqlitePool, source_type: &str, id: &str) -> WorkflowBinding {
        let event_id = format!("event-{id}");
        let outbox_id = format!("outbox-{id}");
        let work_item_id = format!("work-item-{id}");
        let workflow_id = format!("workflow-{id}");
        let payload = json!({ "source": source_type });
        let mut transaction = pool.begin().await.expect("begin workflow fixture");
        record_with_outbox(
            &mut transaction,
            NewDomainEvent {
                event_id: &event_id,
                outbox_id: &outbox_id,
                event_type: "workflow.source.accepted",
                aggregate_type: "test",
                aggregate_id: id,
                payload: &payload,
                actor_id: "test",
                source: "test",
                workspace_id: Some("default"),
                deduplication_key: &event_id,
                security_scope: None,
                correlation_id: id,
                causation_id: None,
                occurred_at: 10,
            },
        )
        .await
        .expect("record source event");
        let binding = create_workflow_in_transaction(
            &mut transaction,
            NewWorkflow {
                work_item_id: &work_item_id,
                workflow_id: &workflow_id,
                event_id: &event_id,
                source_type,
                classification: "agent_required",
                payload: &payload,
                correlation_id: id,
                causation_id: None,
            },
            10,
        )
        .await
        .expect("create workflow");
        transaction.commit().await.expect("commit fixture");
        binding
    }

    #[tokio::test]
    async fn manual_timer_and_rss_sources_share_recoverable_workflow_identity() {
        let (path, pool) = test_pool("sources").await;
        for (run_id, expected_source) in [
            ("run-manual", "manual"),
            ("run-timer", "timer"),
            ("run-rss", "rss"),
        ] {
            let binding = workflow_fixture(pool.as_ref(), expected_source, run_id).await;
            let stored_source: String =
                sqlx::query_scalar("SELECT source_type FROM workflow_work_items WHERE id = ?")
                    .bind(&binding.work_item_id)
                    .fetch_one(pool.as_ref())
                    .await
                    .expect("source type");
            assert_eq!(stored_source, expected_source);
        }
        let counts: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM workflow_work_items), \
                    (SELECT COUNT(*) FROM workflow_instances), \
                    (SELECT COUNT(*) FROM domain_events WHERE event_type = 'workflow.source.accepted')",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("workflow counts");
        assert_eq!(counts, (3, 3, 3));
        cleanup(&path, pool).await;
    }

    #[tokio::test]
    async fn retry_ends_the_old_run_and_starts_a_new_run_id() {
        let (path, pool) = test_pool("retry").await;
        let binding = workflow_fixture(pool.as_ref(), "timer", "automation-run-retry").await;
        start_run(pool.as_ref(), &binding, "runtime-run-1", 1, 20)
            .await
            .expect("start first run");
        mark_retry_scheduled(
            pool.as_ref(),
            &binding.workflow_id,
            Some("runtime-run-1"),
            "retry",
            30,
        )
        .await
        .expect("schedule retry");
        start_run(pool.as_ref(), &binding, "runtime-run-2", 2, 40)
            .await
            .expect("start second run");
        mark_completed(
            pool.as_ref(),
            &binding.workflow_id,
            "runtime-run-2",
            &json!({ "summary": "done" }),
            50,
        )
        .await
        .expect("complete workflow");
        let state: String = sqlx::query_scalar("SELECT state FROM workflow_instances WHERE id = ?")
            .bind(&binding.workflow_id)
            .fetch_one(pool.as_ref())
            .await
            .expect("workflow state");
        let attempts: Vec<(String, String)> = sqlx::query_as(
            "SELECT run_id, status FROM workflow_run_attempts WHERE workflow_id = ? ORDER BY attempt_number",
        )
        .bind(&binding.workflow_id)
        .fetch_all(pool.as_ref())
        .await
        .expect("attempts");
        assert_eq!(state, "COMPLETED");
        assert_eq!(
            attempts,
            vec![
                ("runtime-run-1".to_string(), "failed".to_string()),
                ("runtime-run-2".to_string(), "completed".to_string())
            ]
        );
        cleanup(&path, pool).await;
    }

    #[tokio::test]
    async fn event_suspend_ends_the_run_and_correlated_event_makes_workflow_ready() {
        let (path, pool) = test_pool("event-resume").await;
        let binding = workflow_fixture(pool.as_ref(), "manual", "automation-run-event").await;
        start_run(pool.as_ref(), &binding, "runtime-event-1", 1, 20)
            .await
            .expect("start run");
        let wait_id = suspend_run(
            pool.as_ref(),
            &binding,
            "runtime-event-1",
            SuspendRequest {
                condition_kind: "event",
                deduplication_key: "wait-for-review",
                payload: &json!({ "eventType": "review.received" }),
                due_at: None,
            },
            30,
        )
        .await
        .expect("suspend run");
        let mut transaction = pool.begin().await.expect("event transaction");
        record_with_outbox(
            &mut transaction,
            NewDomainEvent {
                event_id: "review-event-1",
                outbox_id: "review-event-1-outbox",
                event_type: "review.received",
                aggregate_type: "review",
                aggregate_id: "review-1",
                payload: &json!({ "decision": "continue" }),
                actor_id: "local_user",
                source: "test",
                workspace_id: Some("default"),
                deduplication_key: "review-event-1",
                security_scope: None,
                correlation_id: &binding.correlation_id,
                causation_id: Some(&binding.event_id),
                occurred_at: 40,
            },
        )
        .await
        .expect("record event");
        transaction.commit().await.expect("commit event");
        assert_eq!(consume_event_waits(pool.as_ref(), 50).await.unwrap(), 1);
        let stored: (String, Option<String>, String, String) = sqlx::query_as(
            "SELECT workflow.state, workflow.current_wait_condition_id, condition.status, item.status \
             FROM workflow_instances workflow \
             INNER JOIN workflow_wait_conditions condition ON condition.id = ? \
             INNER JOIN workflow_work_items item ON item.id = workflow.work_item_id \
             WHERE workflow.id = ?",
        )
        .bind(&wait_id)
        .bind(&binding.workflow_id)
        .fetch_one(pool.as_ref())
        .await
        .expect("resumed workflow");
        assert_eq!(
            stored,
            ("READY".into(), None, "satisfied".into(), "queued".into())
        );
        start_run(pool.as_ref(), &binding, "runtime-event-2", 2, 60)
            .await
            .expect("start continuation run");
        cleanup(&path, pool).await;
    }

    #[tokio::test]
    async fn core_ingress_scanner_enqueues_sources_and_recovers_expired_actions() {
        let directory = std::env::temp_dir().join(format!(
            "my-notebook-core-ingress-{}-{}",
            std::process::id(),
            now_millis()
        ));
        database::prepare_database_path(&directory, &database::DATABASE_MIGRATOR)
            .await
            .expect("prepare Core ingress database");
        let database_path = directory.join(database::DATABASE_FILENAME);
        let pool = database::get_pool_for_path(&database_path, false)
            .await
            .expect("open Core ingress database");
        sqlx::query(
            "INSERT INTO automation_tasks \
             (id, name, instruction, trigger_type, trigger_config_json, enabled, next_run_at, \
              created_at, updated_at, source_type, source_config_json) VALUES \
             ('core-auto', 'Core Automation', '整理内容', 'interval', \
              '{\"intervalMinutes\":5}', 1, 1, 1, 1, 'document', '{}')",
        )
        .execute(pool.as_ref())
        .await
        .expect("insert due automation");
        let signal_payload = json!({ "since": 1, "triggerSource": "sync", "scope": "all" });
        let mut transaction = pool.begin().await.expect("begin signal event");
        record_with_outbox(
            &mut transaction,
            NewDomainEvent {
                event_id: "core-signal-event",
                outbox_id: "core-signal-outbox",
                event_type: "workspace.signals.refreshed",
                aggregate_type: "workspace_signals",
                aggregate_id: "default",
                payload: &signal_payload,
                actor_id: "test",
                source: "test",
                workspace_id: Some("default"),
                deduplication_key: "core-signal-event",
                security_scope: None,
                correlation_id: "core-signal-event",
                causation_id: None,
                occurred_at: 1,
            },
        )
        .await
        .expect("record signal event");
        transaction.commit().await.expect("commit signal event");

        let action_workflow = workflow_fixture(pool.as_ref(), "manual", "core-action").await;
        start_run(pool.as_ref(), &action_workflow, "core-action-run", 1, 20)
            .await
            .expect("start action workflow");
        let null = Value::Null;
        crate::action_gateway::propose_external_action(
            pool.as_ref(),
            crate::action_gateway::NewExternalAction {
                action_id: "core-expired-action",
                workflow_id: &action_workflow.workflow_id,
                work_item_id: &action_workflow.work_item_id,
                run_id: Some("core-action-run"),
                action_type: "connector.dispatch",
                target: &null,
                input: &null,
                idempotency_key: "core-expired-action",
                correlation_id: &action_workflow.correlation_id,
                causation_id: Some(&action_workflow.event_id),
            },
            21,
        )
        .await
        .expect("propose action");
        crate::action_gateway::decide_external_action(
            pool.as_ref(),
            "core-expired-action",
            true,
            "test",
            &json!({}),
            22,
        )
        .await
        .expect("approve action");
        crate::action_gateway::claim_approved_action(pool.as_ref(), "expired-worker", 30, 1_000)
            .await
            .expect("claim action")
            .expect("approved action exists");

        let state = CoreWorkflowScannerState::default();
        state
            .ensure_for_directory(&directory)
            .await
            .expect("start Core ingress scanner");
        let mut completed = false;
        for _ in 0..40 {
            let counts: (i64, i64, String) = sqlx::query_as(
                "SELECT \
                   (SELECT COUNT(*) FROM automation_runs WHERE automation_id = 'core-auto'), \
                   (SELECT COUNT(*) FROM signal_agent_runs WHERE event_id = 'core-signal-event'), \
                   (SELECT status FROM external_action_requests WHERE id = 'core-expired-action')",
            )
            .fetch_one(pool.as_ref())
            .await
            .expect("read Core ingress results");
            if counts == (1, 1, "approved".to_string()) {
                completed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            completed,
            "Core ingress scanner should advance all durable sources"
        );
        let snapshot = state.snapshot().await;
        assert_eq!(snapshot.status, WorkflowScannerStatus::Running);
        assert_eq!(snapshot.automation_enqueued_count, 1);
        assert_eq!(snapshot.signal_enqueued_count, 1);
        assert_eq!(snapshot.action_recovered_count, 1);
        state.shutdown().await;
        drop(pool);
        database::close_pool(&database_path)
            .await
            .expect("close Core ingress database");
        let _ = std::fs::remove_dir_all(directory);
    }
}
