use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, State};
use tokio::{sync::Mutex, task::JoinHandle, time::Duration};

use crate::{
    database,
    reliability::{now_millis, A2A_RETRY_POLICY},
};

const QUEUE_EVENT: &str = "agent-communication://queue-changed";
const BACKGROUND_LEASE_MS: i64 = 60 * 60 * 1_000;

#[derive(Default)]
pub(crate) struct AgentRequestWatcherState {
    task: Mutex<Option<JoinHandle<()>>>,
    data_directory: Mutex<Option<String>>,
    migration_paused: AtomicBool,
}

pub(crate) struct AgentRequestWatcherMigrationSnapshot {
    pub(crate) was_running: bool,
    pub(crate) data_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartAgentRequestWatcherInput {
    data_directory: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AgentRequestQueueSnapshot {
    actionable_count: i64,
    latest_update_at: Option<i64>,
    occurred_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigureAgentBackgroundRuntimeInput {
    data_directory: Option<String>,
    profile: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimAgentRequestInput {
    data_directory: Option<String>,
    previous_task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettleAgentRequestInput {
    data_directory: Option<String>,
    id: String,
    status: String,
    task_id: Option<String>,
    error: Option<String>,
    result: Option<Value>,
    completed_at: Option<i64>,
}

#[tauri::command]
pub(crate) async fn configure_agent_background_runtime(
    app: AppHandle,
    input: ConfigureAgentBackgroundRuntimeInput,
) -> Result<(), String> {
    validate_background_profile(&input.profile)?;
    let connection = database::open_database(&app, input.data_directory).await?;
    sqlx::query(
        "INSERT INTO agent_background_runtime_profiles (id, profile_json, updated_at) \
         VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET \
         profile_json = excluded.profile_json, updated_at = excluded.updated_at",
    )
    .bind(input.profile.to_string())
    .bind(now_millis())
    .execute(connection.as_ref())
    .await
    .map_err(database::database_error)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn claim_agent_request(
    app: AppHandle,
    input: ClaimAgentRequestInput,
) -> Result<Option<Value>, String> {
    let connection = database::open_database(&app, input.data_directory).await?;
    claim_agent_request_in_pool(connection.as_ref(), input.previous_task_id.as_deref()).await
}

#[tauri::command]
pub(crate) async fn settle_agent_request(
    app: AppHandle,
    input: SettleAgentRequestInput,
) -> Result<(), String> {
    if !matches!(
        input.status.as_str(),
        "awaiting_review" | "completed" | "failed"
    ) {
        return Err("A2A 请求结算状态无效。".to_string());
    }
    let connection = database::open_database(&app, input.data_directory).await?;
    let result_json = input.result.map(|value| value.to_string());
    let result = sqlx::query(
        "UPDATE agent_requests SET status = ?, task_id = COALESCE(?, task_id), error = ?, \
         result_json = COALESCE(?, result_json), updated_at = ?, completed_at = ?, \
         lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE id = ?",
    )
    .bind(&input.status)
    .bind(&input.task_id)
    .bind(
        input
            .error
            .map(|value| value.chars().take(2_000).collect::<String>()),
    )
    .bind(result_json)
    .bind(now_millis())
    .bind(input.completed_at)
    .bind(&input.id)
    .execute(connection.as_ref())
    .await
    .map_err(database::database_error)?;
    if result.rows_affected() != 1 {
        return Err("A2A 请求不存在。".to_string());
    }
    Ok(())
}

async fn claim_agent_request_in_pool(
    connection: &SqlitePool,
    previous_task_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let now = now_millis();
    let lease_owner = new_id("a2a-lease");
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let row = if let Some(task_id) = previous_task_id {
        sqlx::query(
            "SELECT request.*, branch.title AS branch_title, branch.parent_conversation_id \
             FROM agent_requests request LEFT JOIN agent_branches branch ON branch.id = request.branch_id \
             WHERE request.previous_task_id = ? AND request.status = 'queued' \
             AND request.dead_lettered_at IS NULL \
             AND (request.next_attempt_at IS NULL OR request.next_attempt_at <= ?) \
             ORDER BY request.updated_at ASC LIMIT 1",
        )
        .bind(task_id)
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await
    } else {
        sqlx::query(
            "SELECT request.*, branch.title AS branch_title, branch.parent_conversation_id \
             FROM agent_requests request LEFT JOIN agent_branches branch ON branch.id = request.branch_id \
             WHERE request.previous_task_id IS NULL AND request.status = 'queued' \
             AND request.dead_lettered_at IS NULL \
             AND (request.next_attempt_at IS NULL OR request.next_attempt_at <= ?) \
             ORDER BY request.created_at ASC LIMIT 1",
        )
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await
    }
    .map_err(database::database_error)?;
    let Some(row) = row else {
        transaction
            .commit()
            .await
            .map_err(database::database_error)?;
        return Ok(None);
    };
    let id: String = row.try_get("id").map_err(database::database_error)?;
    let result = sqlx::query(
        "UPDATE agent_requests SET status = 'running', updated_at = ?, lease_owner = ?, \
         lease_expires_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL, \
         last_failure_kind = NULL WHERE id = ? AND status = 'queued' AND dead_lettered_at IS NULL \
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
    )
    .bind(now)
    .bind(&lease_owner)
    .bind(now + BACKGROUND_LEASE_MS)
    .bind(&id)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if result.rows_affected() != 1 {
        transaction
            .rollback()
            .await
            .map_err(database::database_error)?;
        return Ok(None);
    }
    let optional_string = |name: &str| row.try_get::<Option<String>, _>(name).unwrap_or(None);
    let request = json!({
        "id": id,
        "prompt": row.try_get::<String, _>("prompt").map_err(database::database_error)?,
        "mode": optional_string("mode").unwrap_or_else(|| "agent".to_string()),
        "projectId": optional_string("project_id"), "branchId": optional_string("branch_id"),
        "branchTitle": optional_string("branch_title"), "parentConversationId": optional_string("parent_conversation_id"),
        "status": "running", "taskId": optional_string("task_id"),
        "previousTaskId": optional_string("previous_task_id"), "revisionFeedback": optional_string("revision_feedback"),
        "revisionCount": row.try_get::<i64, _>("revision_count").unwrap_or(0),
        "attemptCount": row.try_get::<i64, _>("attempt_count").unwrap_or(0) + 1,
        "leaseOwner": lease_owner,
        "result": optional_string("result_json").and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "decision": optional_string("decision_json").and_then(|value| serde_json::from_str::<Value>(&value).ok())
    });
    transaction
        .commit()
        .await
        .map_err(database::database_error)?;
    Ok(Some(request))
}

#[tauri::command]
pub(crate) async fn start_agent_request_watcher(
    app: AppHandle,
    state: State<'_, AgentRequestWatcherState>,
    input: StartAgentRequestWatcherInput,
) -> Result<(), String> {
    let requested_directory = input
        .data_directory
        .filter(|value| !value.trim().is_empty());
    let mut task = state.task.lock().await;
    if state.migration_paused.load(Ordering::SeqCst) {
        return Err("数据目录迁移期间不能启动 Agent 请求 watcher。".to_string());
    }
    let same_directory = *state.data_directory.lock().await == requested_directory;
    if same_directory && task.as_ref().is_some_and(|task| !task.is_finished()) {
        return Ok(());
    }
    if let Some(existing) = task.take() {
        existing.abort();
    }
    *state.data_directory.lock().await = requested_directory.clone();
    *task = Some(tokio::spawn(async move {
        watch_agent_requests(app, requested_directory).await;
    }));
    Ok(())
}

pub(crate) async fn quiesce_for_data_migration(
    state: &AgentRequestWatcherState,
) -> AgentRequestWatcherMigrationSnapshot {
    state.migration_paused.store(true, Ordering::SeqCst);
    let existing = state.task.lock().await.take();
    let was_running = existing.as_ref().is_some_and(|task| !task.is_finished());
    if let Some(existing) = existing {
        existing.abort();
        let _ = existing.await;
    }
    AgentRequestWatcherMigrationSnapshot {
        was_running,
        data_directory: state.data_directory.lock().await.clone(),
    }
}

pub(crate) async fn resume_after_data_migration(
    app: &AppHandle,
    state: &AgentRequestWatcherState,
    snapshot: AgentRequestWatcherMigrationSnapshot,
    data_directory: Option<String>,
) {
    let mut task = state.task.lock().await;
    *state.data_directory.lock().await = data_directory.clone();
    if snapshot.was_running {
        let app = app.clone();
        *task = Some(tokio::spawn(async move {
            watch_agent_requests(app, data_directory).await;
        }));
    }
    state.migration_paused.store(false, Ordering::SeqCst);
}

async fn watch_agent_requests(app: AppHandle, data_directory: Option<String>) {
    let mut last_snapshot: Option<(i64, Option<i64>)> = None;
    let mut startup_recovered = false;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    loop {
        ticker.tick().await;
        let Ok(connection) = database::open_database(&app, data_directory.clone()).await else {
            continue;
        };
        if !startup_recovered {
            let active_run_ids = crate::agent_worker_supervisor::active_run_ids(&app).await;
            if recover_orphaned_background_requests(connection.as_ref(), &active_run_ids)
                .await
                .is_ok()
                && crate::automation_runtime::recover_orphaned_runs(
                    connection.as_ref(),
                    &active_run_ids,
                )
                .await
                .is_ok()
                && crate::signal_runtime::recover_orphaned_runs(
                    connection.as_ref(),
                    &active_run_ids,
                )
                .await
                .is_ok()
                && crate::action_gateway::recover_expired_actions(connection.as_ref(), now_millis())
                    .await
                    .is_ok()
            {
                startup_recovered = true;
            }
        }
        let profile = read_background_profile(connection.as_ref())
            .await
            .ok()
            .flatten();
        if let Err(error) = crate::automation_runtime::tick(
            &app,
            connection.as_ref(),
            data_directory.clone(),
            profile.as_ref(),
        )
        .await
        {
            let _ = app.emit(
                QUEUE_EVENT,
                json!({ "actionableCount": 0, "latestUpdateAt": Value::Null, "occurredAt": now_millis(), "error": error }),
            );
        }
        if let Err(error) = crate::signal_runtime::tick(
            &app,
            connection.as_ref(),
            data_directory.clone(),
            profile.as_ref(),
        )
        .await
        {
            let _ = app.emit(
                QUEUE_EVENT,
                json!({ "actionableCount": 0, "latestUpdateAt": Value::Null, "occurredAt": now_millis(), "error": error }),
            );
        }
        if let Err(error) =
            dispatch_next_background_request(&app, connection.as_ref(), data_directory.clone())
                .await
        {
            let _ = app.emit(
                QUEUE_EVENT,
                json!({ "actionableCount": 0, "latestUpdateAt": Value::Null, "occurredAt": now_millis(), "error": error }),
            );
        }
        let Ok((actionable_count, latest_update_at)) =
            read_queue_snapshot(connection.as_ref()).await
        else {
            continue;
        };
        let signature = (actionable_count, latest_update_at);
        if last_snapshot.as_ref() != Some(&signature) {
            let _ = app.emit(
                QUEUE_EVENT,
                AgentRequestQueueSnapshot {
                    actionable_count,
                    latest_update_at,
                    occurred_at: now_millis(),
                },
            );
        }
        last_snapshot = Some(signature);
    }
}

async fn dispatch_next_background_request(
    app: &AppHandle,
    connection: &SqlitePool,
    data_directory: Option<String>,
) -> Result<(), String> {
    process_background_decision(app, connection, data_directory.clone()).await?;
    let Some(profile) = read_background_profile(connection).await? else {
        return Ok(());
    };
    let request = match claim_agent_request_in_pool(connection, None).await? {
        Some(request) => Some(request),
        None => {
            let previous = sqlx::query_scalar::<_, String>(
                "SELECT previous_task_id FROM agent_requests WHERE status = 'queued' \
                 AND previous_task_id IS NOT NULL AND dead_lettered_at IS NULL \
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?) \
                 ORDER BY created_at ASC LIMIT 1",
            )
            .bind(now_millis())
            .fetch_optional(connection)
            .await
            .map_err(database::database_error)?;
            match previous {
                Some(previous) => claim_agent_request_in_pool(connection, Some(&previous)).await?,
                None => None,
            }
        }
    };
    let Some(request) = request else {
        return Ok(());
    };
    let request_id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "A2A 请求缺少 id。".to_string())?;
    let submission = build_background_submission(connection, &request, &profile).await;
    let (submission, recovery_context) = match submission {
        Ok(value) => value,
        Err(error) => {
            schedule_background_failure(connection, request_id, None, None, &error, false).await?;
            return Ok(());
        }
    };
    let recovery_for_failure = recovery_context.clone();
    if let Err(error) = crate::agent_worker_supervisor::start_background_orchestration(
        app,
        data_directory,
        submission,
        recovery_context,
    )
    .await
    {
        schedule_background_failure(
            connection,
            request_id,
            None,
            recovery_for_failure
                .get("cognitiveSessionId")
                .and_then(Value::as_str),
            &error,
            true,
        )
        .await?;
    }
    Ok(())
}

async fn recover_orphaned_background_requests(
    connection: &SqlitePool,
    active_run_ids: &[String],
) -> Result<usize, String> {
    let rows = sqlx::query(
        "SELECT id, run_id, task_id, cognitive_session_id, attempt_count FROM agent_requests \
         WHERE status = 'running' ORDER BY updated_at ASC",
    )
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?;
    let active = active_run_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut recovered = 0;
    for row in rows {
        let run_id = row.try_get::<Option<String>, _>("run_id").unwrap_or(None);
        if run_id
            .as_deref()
            .is_some_and(|run_id| active.contains(run_id))
        {
            continue;
        }
        let id: String = row.try_get("id").map_err(database::database_error)?;
        let task_id = row.try_get::<Option<String>, _>("task_id").unwrap_or(None);
        let session_id = row
            .try_get::<Option<String>, _>("cognitive_session_id")
            .unwrap_or(None);
        let attempts = row.try_get::<i64, _>("attempt_count").unwrap_or(0);
        if A2A_RETRY_POLICY.exhausted(attempts) {
            dead_letter_background_request(
                connection,
                &id,
                task_id.as_deref(),
                session_id.as_deref(),
                "应用恢复时发现请求已超过最大尝试次数。",
                "startup_recovery_exhausted",
            )
            .await?;
        } else {
            mark_background_attempt_abandoned(
                connection,
                task_id.as_deref(),
                session_id.as_deref(),
                "应用恢复时回收了失去所有者的后台 Run。",
            )
            .await?;
            sqlx::query(
                "UPDATE agent_requests SET status = 'queued', task_id = NULL, run_id = NULL, \
                 cognitive_session_id = NULL, lease_owner = NULL, lease_expires_at = NULL, \
                 next_attempt_at = ?, last_failure_kind = 'startup_recovery', error = ?, \
                 updated_at = ? WHERE id = ? AND status = 'running'",
            )
            .bind(now_millis())
            .bind("应用恢复时回收了失去所有者的后台 Run。")
            .bind(now_millis())
            .bind(&id)
            .execute(connection)
            .await
            .map_err(database::database_error)?;
        }
        recovered += 1;
    }
    Ok(recovered)
}

async fn schedule_background_failure(
    connection: &SqlitePool,
    request_id: &str,
    task_id: Option<&str>,
    cognitive_session_id: Option<&str>,
    error: &str,
    retryable: bool,
) -> Result<(), String> {
    let attempts = sqlx::query_scalar::<_, i64>(
        "SELECT attempt_count FROM agent_requests WHERE id = ? LIMIT 1",
    )
    .bind(request_id)
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?
    .ok_or_else(|| "A2A 请求不存在。".to_string())?;
    if !retryable || A2A_RETRY_POLICY.exhausted(attempts) {
        return dead_letter_background_request(
            connection,
            request_id,
            task_id,
            cognitive_session_id,
            error,
            if retryable {
                "retry_exhausted"
            } else {
                "non_retryable"
            },
        )
        .await;
    }
    mark_background_attempt_abandoned(connection, task_id, cognitive_session_id, error).await?;
    let delay_ms = A2A_RETRY_POLICY.delay_ms(attempts);
    let now = now_millis();
    sqlx::query(
        "UPDATE agent_requests SET status = 'queued', task_id = NULL, run_id = NULL, \
         cognitive_session_id = NULL, lease_owner = NULL, lease_expires_at = NULL, \
         next_attempt_at = ?, last_failure_kind = 'retryable', error = ?, updated_at = ?, \
         completed_at = NULL WHERE id = ?",
    )
    .bind(now + delay_ms)
    .bind(error.chars().take(2_000).collect::<String>())
    .bind(now)
    .bind(request_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

async fn dead_letter_background_request(
    connection: &SqlitePool,
    request_id: &str,
    task_id: Option<&str>,
    cognitive_session_id: Option<&str>,
    error: &str,
    failure_kind: &str,
) -> Result<(), String> {
    mark_background_attempt_abandoned(connection, task_id, cognitive_session_id, error).await?;
    let now = now_millis();
    sqlx::query(
        "UPDATE agent_requests SET status = 'failed', error = ?, updated_at = ?, completed_at = ?, \
         lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, \
         dead_lettered_at = ?, last_failure_kind = ? WHERE id = ?",
    )
    .bind(error.chars().take(2_000).collect::<String>())
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(failure_kind)
    .bind(request_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    Ok(())
}

async fn mark_background_attempt_abandoned(
    connection: &SqlitePool,
    task_id: Option<&str>,
    cognitive_session_id: Option<&str>,
    error: &str,
) -> Result<(), String> {
    let now = now_millis();
    if let Some(task_id) = task_id {
        sqlx::query("UPDATE agent_tasks SET status = 'interrupted', current_step = '后台 Run 已失去 lease', error = ?, completed_at = ? WHERE id = ? AND status IN ('running', 'waiting_confirmation')")
            .bind(error.chars().take(2_000).collect::<String>()).bind(now).bind(task_id)
            .execute(connection).await.map_err(database::database_error)?;
    }
    if let Some(session_id) = cognitive_session_id {
        sqlx::query("UPDATE cognitive_sessions SET status = 'cancelled', state_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('active', 'waiting_user')")
            .bind(json!({ "error": error, "reason": "background_attempt_abandoned" }).to_string())
            .bind(now).bind(session_id).execute(connection).await.map_err(database::database_error)?;
    }
    Ok(())
}

pub(crate) async fn renew_background_lease(
    connection: &SqlitePool,
    recovery: &Value,
) -> Result<(), String> {
    if crate::automation_runtime::renew_lease(connection, recovery).await? {
        return Ok(());
    }
    if crate::signal_runtime::renew_lease(connection, recovery).await? {
        return Ok(());
    }
    if recovery.get("kind").and_then(Value::as_str) != Some("a2a") {
        return Ok(());
    }
    let request_id = required_value_string(recovery, "requestId")?;
    let lease_owner = required_value_string(recovery, "leaseOwner")?;
    let now = now_millis();
    sqlx::query("UPDATE agent_requests SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?")
        .bind(now + BACKGROUND_LEASE_MS).bind(now).bind(request_id).bind(lease_owner)
        .execute(connection).await.map_err(database::database_error)?;
    Ok(())
}

async fn process_background_decision(
    app: &AppHandle,
    connection: &SqlitePool,
    data_directory: Option<String>,
) -> Result<(), String> {
    let row = sqlx::query(
        "SELECT id, status, task_id FROM agent_requests WHERE status IN ('approved', 'rejected') AND task_id IS NOT NULL ORDER BY updated_at ASC LIMIT 1",
    )
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?;
    let Some(row) = row else {
        return Ok(());
    };
    let id: String = row.try_get("id").map_err(database::database_error)?;
    let status: String = row.try_get("status").map_err(database::database_error)?;
    let task_id: String = row.try_get("task_id").map_err(database::database_error)?;
    match crate::agent_repository::apply_background_patch_decision(
        app,
        data_directory,
        &task_id,
        status == "approved",
    )
    .await
    {
        Ok(()) => {
            settle_request_in_pool(connection, &id, "completed", Some(&task_id), None, None).await
        }
        Err(error) => {
            settle_request_in_pool(
                connection,
                &id,
                "failed",
                Some(&task_id),
                Some(&error),
                None,
            )
            .await
        }
    }
}

async fn read_background_profile(connection: &SqlitePool) -> Result<Option<Value>, String> {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT profile_json FROM agent_background_runtime_profiles WHERE id = 'default' LIMIT 1",
    )
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?;
    value
        .map(|value| serde_json::from_str(&value).map_err(database::database_error))
        .transpose()
}

async fn build_background_submission(
    connection: &SqlitePool,
    request: &Value,
    profile: &Value,
) -> Result<(Value, Value), String> {
    validate_background_profile(profile)?;
    let request_id = required_value_string(request, "id")?;
    let prompt = required_value_string(request, "prompt")?;
    let objective = match request.get("revisionFeedback").and_then(Value::as_str) {
        Some(feedback) if !feedback.trim().is_empty() => format!(
            "{prompt}\n\n这是对上一版提案的修订。必须保留仍然有效的部分，并按以下反馈修正：\n{}\n\n上一版摘要：{}",
            feedback.trim(),
            request
                .get("result")
                .and_then(|value| value.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or("未提供")
        ),
        _ => prompt,
    };
    let mode = request
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    let intent = if mode == "learning" {
        "learning"
    } else if matches!(mode, "research" | "review") {
        mode
    } else {
        "agent"
    };
    let project_id = request
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let conversation_id = request
        .get("branchId")
        .and_then(Value::as_str)
        .unwrap_or(&request_id);
    let workspace = read_workspace_projection(connection, project_id).await?;
    let document_id = workspace
        .get("rootDocumentIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(str::to_string)
        .or(sqlx::query_scalar::<_, String>(
            "SELECT id FROM documents WHERE document_kind = 'article' AND is_deleted = 0 ORDER BY updated_at DESC LIMIT 1",
        )
        .fetch_optional(connection)
        .await
        .map_err(database::database_error)?)
        .ok_or_else(|| "后台 Agent 没有可读取的文档。".to_string())?;
    let document = read_document_projection(connection, &document_id).await?;
    let run_id = new_id("run");
    let task_id = new_id("agent-task");
    let cognitive_session_id =
        matches!(intent, "research" | "review" | "learning").then(|| new_id("cognitive-session"));
    if let Some(session_id) = cognitive_session_id.as_deref() {
        create_background_cognitive_session(
            connection,
            session_id,
            conversation_id,
            intent,
            &document_id,
        )
        .await?;
    }
    sqlx::query("UPDATE agent_requests SET run_id = ?, cognitive_session_id = ?, updated_at = ? WHERE id = ? AND status = 'running'")
        .bind(&run_id)
        .bind(&cognitive_session_id)
        .bind(now_millis())
        .bind(&request_id)
        .execute(connection)
        .await
        .map_err(database::database_error)?;
    let submission = json!({
        "version": 1,
        "runId": run_id,
        "workItemId": task_id,
        "workflowId": request_id,
        "sessionId": cognitive_session_id.as_deref().unwrap_or(conversation_id),
        "document": document,
        "workspace": {
            "projectId": project_id,
            "projectName": workspace.get("projectName").and_then(Value::as_str).unwrap_or("外部 Agent 任务"),
            "rootDocumentIds": workspace.get("rootDocumentIds").cloned().unwrap_or_else(|| json!([])),
            "conversationId": conversation_id
        },
        "objective": objective,
        "intent": intent,
        "systemInstructions": profile.get("systemInstructions").and_then(Value::as_str).unwrap_or_default(),
        "modelPolicy": profile.get("modelPolicy").cloned().unwrap_or(Value::Null),
        "configuredMaxTokens": profile.get("configuredMaxTokens").and_then(Value::as_i64).unwrap_or(2048),
        "externalTools": [],
        "explicitTargets": [],
        "correlationId": request_id,
        "causationId": request.get("previousTaskId").cloned().unwrap_or(Value::Null)
    });
    let recovery = json!({
        "kind": "a2a",
        "requestId": request_id,
        "runId": run_id,
        "leaseOwner": request.get("leaseOwner").cloned().unwrap_or(Value::Null),
        "cognitiveSessionId": cognitive_session_id,
        "intent": intent
    });
    Ok((submission, recovery))
}

async fn read_workspace_projection(
    connection: &SqlitePool,
    project_id: &str,
) -> Result<Value, String> {
    let state = sqlx::query_scalar::<_, String>(
        "SELECT state_json FROM agent_workspace_state WHERE id = 'current' LIMIT 1",
    )
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?
    .and_then(|value| serde_json::from_str::<Value>(&value).ok())
    .unwrap_or_else(|| json!({ "projects": [] }));
    let project = state
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(project_id));
    Ok(json!({
        "projectName": project.and_then(|item| item.get("name")).and_then(Value::as_str).unwrap_or("外部 Agent 任务"),
        "rootDocumentIds": project.and_then(|item| item.get("workspaceRootIds")).cloned().unwrap_or_else(|| json!([]))
    }))
}

pub(crate) async fn read_document_projection(
    connection: &SqlitePool,
    document_id: &str,
) -> Result<Value, String> {
    let row = sqlx::query(
        "SELECT id, title, plain_text, revision FROM documents WHERE id = ? AND document_kind = 'article' AND is_deleted = 0 LIMIT 1",
    )
    .bind(document_id)
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?
    .ok_or_else(|| "后台 Agent 目标文档不存在。".to_string())?;
    let blocks = sqlx::query(
        "SELECT id, block_type, block_index, plain_text FROM blocks WHERE document_id = ? ORDER BY block_index ASC",
    )
    .bind(document_id)
    .fetch_all(connection)
    .await
    .map_err(database::database_error)?
    .into_iter()
    .map(|block| json!({
        "id": block.try_get::<String, _>("id").unwrap_or_default(),
        "type": block.try_get::<String, _>("block_type").unwrap_or_else(|_| "paragraph".to_string()),
        "text": block.try_get::<String, _>("plain_text").unwrap_or_default(),
        "markdown": block.try_get::<String, _>("plain_text").unwrap_or_default(),
        "index": block.try_get::<i64, _>("block_index").unwrap_or(0)
    }))
    .collect::<Vec<_>>();
    let documents = sqlx::query("SELECT id, title, document_kind, is_deleted, parent_id FROM documents ORDER BY sort_order ASC")
        .fetch_all(connection).await.map_err(database::database_error)?
        .into_iter().map(|item| json!({
            "id": item.try_get::<String, _>("id").unwrap_or_default(),
            "title": item.try_get::<String, _>("title").unwrap_or_default(),
            "documentKind": item.try_get::<String, _>("document_kind").unwrap_or_else(|_| "article".to_string()),
            "isDeleted": item.try_get::<i64, _>("is_deleted").unwrap_or(0) != 0,
            "parentId": item.try_get::<Option<String>, _>("parent_id").unwrap_or(None)
        })).collect::<Vec<_>>();
    let text = row
        .try_get::<String, _>("plain_text")
        .map_err(database::database_error)?;
    Ok(json!({
        "id": row.try_get::<String, _>("id").map_err(database::database_error)?,
        "title": row.try_get::<String, _>("title").map_err(database::database_error)?,
        "tags": [], "sourceUrl": "", "author": "", "text": text, "markdown": text,
        "revision": row.try_get::<i64, _>("revision").map_err(database::database_error)?,
        "blocks": blocks, "selectedBlockIds": [], "documents": documents
    }))
}

async fn create_background_cognitive_session(
    connection: &SqlitePool,
    id: &str,
    conversation_id: &str,
    mode: &str,
    document_id: &str,
) -> Result<(), String> {
    let now = now_millis();
    sqlx::query(
        "INSERT INTO cognitive_sessions (id, conversation_id, mode_id, mode_version, template_id, template_version, skill_ids_json, target_document_ids_json, target_block_ids_json, state_json, status, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, '[]', ?, '[]', '{}', 'active', 1, ?, ?)",
    )
    .bind(id).bind(conversation_id).bind(mode).bind(format!("{mode}-default"))
    .bind(json!([document_id]).to_string()).bind(now).bind(now)
    .execute(connection).await.map_err(database::database_error)?;
    Ok(())
}

pub(crate) async fn bind_background_request_task(
    connection: &SqlitePool,
    recovery: &Value,
    task_id: &str,
) -> Result<(), String> {
    if crate::automation_runtime::bind_agent_task(connection, recovery, task_id).await? {
        return Ok(());
    }
    if crate::signal_runtime::bind_agent_task(connection, recovery, task_id).await? {
        return Ok(());
    }
    if recovery.get("kind").and_then(Value::as_str) != Some("a2a") {
        return Ok(());
    }
    let request_id = required_value_string(recovery, "requestId")?;
    let run_id = required_value_string(recovery, "runId")?;
    let updated = sqlx::query(
        "UPDATE agent_requests SET task_id = ?, updated_at = ? \
         WHERE id = ? AND status = 'running' AND run_id = ?",
    )
    .bind(task_id)
    .bind(now_millis())
    .bind(request_id)
    .bind(run_id)
    .execute(connection)
    .await
    .map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("A2A 请求已不再属于当前 Run，拒绝绑定任务。".to_string());
    }
    Ok(())
}

pub(crate) async fn settle_background_run(
    connection: &SqlitePool,
    recovery: &Value,
    task_id: Option<&str>,
    result: Option<&Value>,
    error: Option<&str>,
    retryable: bool,
) -> Result<(), String> {
    if crate::automation_runtime::settle_run(
        connection, recovery, task_id, result, error, retryable,
    )
    .await?
    {
        return Ok(());
    }
    if crate::signal_runtime::settle_run(connection, recovery, task_id, result, error, retryable)
        .await?
    {
        return Ok(());
    }
    if recovery.get("kind").and_then(Value::as_str) != Some("a2a") {
        return Ok(());
    }
    let request_id = required_value_string(recovery, "requestId")?;
    let run_id = required_value_string(recovery, "runId")?;
    if let Some(error) = error {
        if !is_current_background_run(connection, &request_id, &run_id).await? {
            return Ok(());
        }
        return schedule_background_failure(
            connection,
            &request_id,
            task_id,
            recovery.get("cognitiveSessionId").and_then(Value::as_str),
            error,
            retryable,
        )
        .await;
    }
    let result = result.ok_or_else(|| "后台 Run 缺少终态结果。".to_string())?;
    let finalization = result.get("sidecarFinalization");
    let structured = result
        .get("structuredOutput")
        .cloned()
        .unwrap_or(Value::Null);
    let report = finalization.and_then(|value| value.get("report")).cloned().unwrap_or_else(|| json!({
        "version": 1, "outcome": "no_change", "summary": structured.get("summary").and_then(Value::as_str).unwrap_or("认知任务已完成。"), "patchCount": 0, "targetDocumentIds": [],
        "cognitive": { "mode": recovery.get("intent").cloned().unwrap_or_else(|| json!("research")), "result": structured }
    }));
    let status = if finalization
        .and_then(|value| value.get("taskStatus"))
        .and_then(Value::as_str)
        == Some("waiting_confirmation")
    {
        "awaiting_review"
    } else {
        "completed"
    };
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let current = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT status, run_id FROM agent_requests WHERE id = ? LIMIT 1",
    )
    .bind(&request_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database::database_error)?
    .ok_or_else(|| "A2A 请求不存在。".to_string())?;
    if current.0 != "running" || current.1.as_deref() != Some(run_id.as_str()) {
        transaction
            .rollback()
            .await
            .map_err(database::database_error)?;
        return Ok(());
    }
    if let Some(session_id) = recovery.get("cognitiveSessionId").and_then(Value::as_str) {
        if recovery.get("intent").and_then(Value::as_str) == Some("research") {
            persist_research_candidates(&mut transaction, session_id, &run_id, &structured).await?;
        }
        let next = if recovery.get("intent").and_then(Value::as_str) == Some("learning")
            && structured.get("phase").and_then(Value::as_str) == Some("waiting_user")
        {
            "waiting_user"
        } else {
            "completed"
        };
        update_cognitive_terminal(&mut transaction, session_id, next, &structured).await?;
    }
    if finalization.is_none() {
        if let Some(task_id) = task_id {
            let updated = sqlx::query("UPDATE agent_tasks SET status = 'completed', current_step = '认知结果已持久化', error = NULL, completed_at = ? WHERE id = ? AND run_id = ? AND status IN ('running', 'waiting_confirmation')")
                .bind(now_millis()).bind(task_id).bind(&run_id).execute(&mut *transaction).await.map_err(database::database_error)?;
            if updated.rows_affected() != 1 {
                return Err("A2A 认知任务已不再属于当前 Run。".to_string());
            }
        }
    }
    let completed_at = (status != "awaiting_review").then(now_millis);
    let settled = sqlx::query(
        "UPDATE agent_requests SET status = ?, task_id = COALESCE(?, task_id), error = NULL, \
         result_json = ?, updated_at = ?, completed_at = ?, lease_owner = NULL, \
         lease_expires_at = NULL, next_attempt_at = NULL \
         WHERE id = ? AND status = 'running' AND run_id = ?",
    )
    .bind(status)
    .bind(task_id)
    .bind(report.to_string())
    .bind(now_millis())
    .bind(completed_at)
    .bind(&request_id)
    .bind(&run_id)
    .execute(&mut *transaction)
    .await
    .map_err(database::database_error)?;
    if settled.rows_affected() != 1 {
        return Err("A2A 请求已不再属于当前 Run。".to_string());
    }
    transaction.commit().await.map_err(database::database_error)
}

async fn persist_research_candidates(
    transaction: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    run_id: &str,
    result: &Value,
) -> Result<(), String> {
    let items = result
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "Research 结果缺少 items。".to_string())?;
    let now = now_millis();
    for item in items {
        let item_id = required_value_string(item, "id")?;
        let title = required_value_string(item, "title")?;
        let content = required_value_string(item, "content")?;
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("claim");
        let object_type = if kind == "conflict" { "claim" } else { kind };
        if !matches!(
            object_type,
            "fact"
                | "claim"
                | "inference"
                | "assumption"
                | "concept"
                | "question"
                | "limitation"
                | "evidence"
        ) {
            return Err(format!("Research item kind {kind} 无效。"));
        }
        let candidate_id = stable_projection_id(
            "knowledge-candidate",
            &[session_id, run_id, item_id.as_str()],
        );
        let sources = item
            .get("sources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let primary = sources.first();
        let validation_status = item
            .get("validationStatus")
            .and_then(Value::as_str)
            .unwrap_or("unverified");
        let validation_message = item
            .get("validationMessage")
            .and_then(Value::as_str)
            .unwrap_or("未提供验证说明。");
        sqlx::query(
            "INSERT OR IGNORE INTO knowledge_objects (id, object_type, status, title, content, structured_data_json, generated_run_id, cognitive_mode, template_id, template_version, scope_json, document_id, block_id, source_revision, authority_level, confidence, version, created_at, updated_at) VALUES (?, ?, 'candidate', ?, ?, ?, ?, 'research', 'research-default', 1, '{}', ?, ?, ?, 'agent_candidate', ?, 1, ?, ?)",
        )
        .bind(&candidate_id).bind(object_type).bind(title).bind(content)
        .bind(json!({ "researchItemId": item_id, "researchKind": kind, "validationStatus": validation_status, "validationMessage": validation_message, "reviewState": "pending", "sessionId": session_id, "outputContractId": "research-result" }).to_string())
        .bind(run_id)
        .bind(primary.and_then(|source| source.get("documentId")).and_then(Value::as_str))
        .bind(primary.and_then(|source| source.get("blockId")).and_then(Value::as_str))
        .bind(primary.and_then(|source| source.get("revision")).and_then(Value::as_i64))
        .bind(item.get("confidence").and_then(Value::as_f64)).bind(now).bind(now)
        .execute(&mut **transaction).await.map_err(database::database_error)?;
        for (source_index, source) in sources.iter().enumerate() {
            let Some(document_id) = source.get("documentId").and_then(Value::as_str) else {
                continue;
            };
            let Some(revision) = source.get("revision").and_then(Value::as_i64) else {
                continue;
            };
            let source_index = source_index.to_string();
            let source_id = stable_projection_id(
                "knowledge-source",
                &[candidate_id.as_str(), source_index.as_str()],
            );
            sqlx::query("INSERT OR IGNORE INTO knowledge_object_sources (id, knowledge_object_id, document_id, block_id, revision, quote, start_offset, end_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)")
                .bind(source_id).bind(&candidate_id).bind(document_id)
                .bind(source.get("blockId").and_then(Value::as_str)).bind(revision)
                .bind(source.get("quote").and_then(Value::as_str)).bind(now)
                .execute(&mut **transaction).await.map_err(database::database_error)?;
        }
        let verdict = if validation_status == "verified" {
            "passed"
        } else if validation_status == "warning" {
            "warning"
        } else {
            "unverifiable"
        };
        sqlx::query("INSERT OR IGNORE INTO knowledge_validations (id, knowledge_object_id, rule_id, verdict, severity, message, source_json, validated_at) VALUES (?, ?, 'research-output-validation', ?, ?, ?, ?, ?)")
            .bind(stable_projection_id("knowledge-validation", &[candidate_id.as_str()])).bind(&candidate_id).bind(verdict)
            .bind(if validation_status == "verified" { "info" } else { "warning" })
            .bind(validation_message).bind(json!({ "itemId": item_id, "sourceCount": sources.len() }).to_string()).bind(now)
            .execute(&mut **transaction).await.map_err(database::database_error)?;
    }
    Ok(())
}

async fn update_cognitive_terminal(
    transaction: &mut Transaction<'_, Sqlite>,
    id: &str,
    status: &str,
    state: &Value,
) -> Result<(), String> {
    let updated = sqlx::query("UPDATE cognitive_sessions SET state_json = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('active', 'waiting_user')")
        .bind(state.to_string()).bind(status).bind(now_millis()).bind(id)
        .execute(&mut **transaction).await.map_err(database::database_error)?;
    if updated.rows_affected() != 1 {
        return Err("Cognitive Session 已不再接受当前 Run 的终态。".to_string());
    }
    Ok(())
}

async fn is_current_background_run(
    connection: &SqlitePool,
    request_id: &str,
    run_id: &str,
) -> Result<bool, String> {
    let current = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT status, run_id FROM agent_requests WHERE id = ? LIMIT 1",
    )
    .bind(request_id)
    .fetch_optional(connection)
    .await
    .map_err(database::database_error)?;
    Ok(current.is_some_and(|(status, current_run_id)| {
        status == "running" && current_run_id.as_deref() == Some(run_id)
    }))
}

async fn settle_request_in_pool(
    connection: &SqlitePool,
    id: &str,
    status: &str,
    task_id: Option<&str>,
    error: Option<&str>,
    result: Option<&Value>,
) -> Result<(), String> {
    let completed_at = (status != "awaiting_review").then(now_millis);
    sqlx::query("UPDATE agent_requests SET status = ?, task_id = COALESCE(?, task_id), error = ?, result_json = COALESCE(?, result_json), updated_at = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE id = ?")
        .bind(status).bind(task_id).bind(error.map(|value| value.chars().take(2_000).collect::<String>()))
        .bind(result.map(Value::to_string)).bind(now_millis()).bind(completed_at).bind(id)
        .execute(connection).await.map_err(database::database_error)?;
    Ok(())
}

pub(crate) fn validate_background_profile(profile: &Value) -> Result<(), String> {
    if profile.to_string().to_ascii_lowercase().contains("apikey") {
        return Err("后台 Runtime Profile 不得包含 API Key。".to_string());
    }
    let policy = profile
        .get("modelPolicy")
        .and_then(Value::as_object)
        .ok_or_else(|| "后台 Runtime Profile 缺少 modelPolicy。".to_string())?;
    for name in ["provider", "model", "endpoint"] {
        if policy
            .get(name)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(format!("后台 Runtime Profile 缺少 {name}。"));
        }
    }
    Ok(())
}

fn required_value_string(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少 {name}。"))
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

fn stable_projection_id(namespace: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{namespace}-{:x}", hasher.finalize())
}

async fn read_queue_snapshot(connection: &SqlitePool) -> Result<(i64, Option<i64>), String> {
    let now = now_millis();
    let row = sqlx::query(
        "SELECT COUNT(*) AS actionable_count, MAX(updated_at) AS latest_update_at \
         FROM agent_requests WHERE status IN ('approved', 'rejected', 'failed') OR \
         (status = 'queued' AND dead_lettered_at IS NULL AND \
         (next_attempt_at IS NULL OR next_attempt_at <= ?))",
    )
    .bind(now)
    .fetch_one(connection)
    .await
    .map_err(database::database_error)?;
    Ok((
        row.try_get::<i64, _>("actionable_count")
            .map_err(database::database_error)?,
        row.try_get::<Option<i64>, _>("latest_update_at")
            .map_err(database::database_error)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queue_snapshot_tracks_only_actionable_a2a_requests() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-agent-request-watcher-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = database::get_pool_for_path(&path, true)
            .await
            .expect("open database");
        database::DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("migrate");
        for (id, status, updated_at) in [
            ("queued", "queued", 10_i64),
            ("review", "awaiting_review", 20_i64),
            ("approved", "approved", 30_i64),
        ] {
            sqlx::query(
                "INSERT INTO agent_requests (id, prompt, status, created_at, updated_at) \
                 VALUES (?, 'test', ?, 1, ?)",
            )
            .bind(id)
            .bind(status)
            .bind(updated_at)
            .execute(pool.as_ref())
            .await
            .expect("insert request");
        }
        assert_eq!(
            read_queue_snapshot(pool.as_ref()).await.unwrap(),
            (2, Some(30))
        );
        drop(pool);
        database::close_pool(&path).await.expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn claim_is_atomic_and_returns_the_persisted_request_projection() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-agent-request-claim-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = database::get_pool_for_path(&path, true)
            .await
            .expect("open database");
        database::DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("migrate");
        sqlx::query(
            "INSERT INTO agent_requests \
             (id, prompt, mode, status, project_id, revision_count, created_at, updated_at) \
             VALUES ('request-1', 'review it', 'review', 'queued', 'project-1', 2, 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("insert request");

        let claimed = claim_agent_request_in_pool(pool.as_ref(), None)
            .await
            .expect("claim")
            .expect("request");
        assert_eq!(claimed["id"], "request-1");
        assert_eq!(claimed["status"], "running");
        assert_eq!(claimed["mode"], "review");
        assert_eq!(claimed["projectId"], "project-1");
        assert_eq!(claimed["revisionCount"], 2);
        assert_eq!(claimed["attemptCount"], 1);
        assert!(claimed["leaseOwner"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        let lease: (i64, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT attempt_count, lease_owner, lease_expires_at FROM agent_requests WHERE id = 'request-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("read lease");
        assert_eq!(lease.0, 1);
        assert!(lease.1.is_some());
        assert!(lease.2.is_some_and(|expires_at| expires_at > now_millis()));
        assert!(claim_agent_request_in_pool(pool.as_ref(), None)
            .await
            .expect("second claim")
            .is_none());

        drop(pool);
        database::close_pool(&path).await.expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn builds_a_credential_free_background_submission_from_sqlite() {
        let (path, pool) = test_pool("background-submission").await;
        sqlx::query("INSERT INTO documents (id, title, content_json, plain_text, revision, created_at, updated_at) VALUES ('doc-1', 'Target', '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"attrs\":{\"id\":\"block-1\"},\"content\":[{\"type\":\"text\",\"text\":\"Body\"}]}]}', 'Body', 3, 1, 1)")
            .execute(pool.as_ref()).await.expect("insert document");
        sqlx::query("INSERT INTO agent_workspace_state (id, state_json, updated_at) VALUES ('current', '{\"projects\":[{\"id\":\"project-1\",\"name\":\"Project\",\"workspaceRootIds\":[\"doc-1\"]}]}', 1)")
            .execute(pool.as_ref()).await.expect("insert workspace");
        sqlx::query("INSERT INTO agent_requests (id, prompt, mode, status, project_id, created_at, updated_at) VALUES ('request-1', 'Review', 'review', 'running', 'project-1', 1, 1)")
            .execute(pool.as_ref()).await.expect("insert request");
        let profile = json!({
            "modelPolicy": { "provider": "openai", "model": "test-model", "endpoint": "https://example.com/v1", "temperature": 0.2, "topP": 1, "reasoningEffort": "auto", "maxOutputTokens": 1000, "credentialRef": { "kind": "provider_secret", "provider": "openai" } },
            "configuredMaxTokens": 1000, "systemInstructions": "safe"
        });
        let (submission, recovery) = build_background_submission(
            pool.as_ref(),
            &json!({ "id": "request-1", "prompt": "Review", "mode": "review", "projectId": "project-1", "branchId": "branch-1", "leaseOwner": "lease-1" }),
            &profile,
        ).await.expect("build submission");
        assert_eq!(submission["intent"], "review");
        assert_eq!(submission["document"]["id"], "doc-1");
        assert_eq!(submission["workspace"]["rootDocumentIds"], json!(["doc-1"]));
        assert_eq!(recovery["kind"], "a2a");
        assert_eq!(recovery["leaseOwner"], "lease-1");
        assert!(!submission
            .to_string()
            .to_ascii_lowercase()
            .contains("apikey"));
        close_test_pool(path, pool).await;
    }

    #[tokio::test]
    async fn retries_retryable_failures_then_dead_letters_exhausted_requests() {
        let (path, pool) = test_pool("background-retry").await;
        sqlx::query(
            "INSERT INTO agent_requests (id, prompt, status, attempt_count, created_at, updated_at) \
             VALUES ('request-1', 'Retry', 'running', 1, 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("insert request");

        schedule_background_failure(
            pool.as_ref(),
            "request-1",
            None,
            None,
            "temporary provider failure",
            true,
        )
        .await
        .expect("schedule retry");
        let retry: (String, Option<i64>, Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT status, next_attempt_at, dead_lettered_at, last_failure_kind \
             FROM agent_requests WHERE id = 'request-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("read retry state");
        assert_eq!(retry.0, "queued");
        assert!(retry
            .1
            .is_some_and(|next_attempt| next_attempt > now_millis()));
        assert_eq!(retry.2, None);
        assert_eq!(retry.3.as_deref(), Some("retryable"));

        sqlx::query(
            "UPDATE agent_requests SET status = 'running', attempt_count = ?, next_attempt_at = NULL WHERE id = 'request-1'",
        )
        .bind(A2A_RETRY_POLICY.max_attempts)
        .execute(pool.as_ref())
        .await
        .expect("exhaust attempts");
        schedule_background_failure(
            pool.as_ref(),
            "request-1",
            None,
            None,
            "provider still unavailable",
            true,
        )
        .await
        .expect("dead letter request");
        let exhausted: (String, Option<i64>, Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT status, next_attempt_at, dead_lettered_at, last_failure_kind \
             FROM agent_requests WHERE id = 'request-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("read dead letter state");
        assert_eq!(exhausted.0, "failed");
        assert_eq!(exhausted.1, None);
        assert!(exhausted.2.is_some());
        assert_eq!(exhausted.3.as_deref(), Some("retry_exhausted"));
        close_test_pool(path, pool).await;
    }

    #[tokio::test]
    async fn startup_recovery_preserves_active_runs_and_requeues_orphans() {
        let (path, pool) = test_pool("background-recovery").await;
        for (id, run_id) in [
            ("request-active", "run-active"),
            ("request-orphan", "run-orphan"),
        ] {
            sqlx::query(
                "INSERT INTO agent_requests (id, prompt, status, run_id, attempt_count, lease_owner, lease_expires_at, created_at, updated_at) \
                 VALUES (?, 'Recover', 'running', ?, 1, 'old-owner', 1, 1, 1)",
            )
            .bind(id)
            .bind(run_id)
            .execute(pool.as_ref())
            .await
            .expect("insert running request");
        }

        let recovered =
            recover_orphaned_background_requests(pool.as_ref(), &["run-active".to_string()])
                .await
                .expect("recover startup requests");
        assert_eq!(recovered, 1);
        let active: (String, Option<String>) =
            sqlx::query_as("SELECT status, run_id FROM agent_requests WHERE id = 'request-active'")
                .fetch_one(pool.as_ref())
                .await
                .expect("read active request");
        assert_eq!(
            active,
            ("running".to_string(), Some("run-active".to_string()))
        );
        let orphan: (String, Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT status, run_id, lease_owner, next_attempt_at FROM agent_requests WHERE id = 'request-orphan'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("read recovered request");
        assert_eq!(orphan.0, "queued");
        assert_eq!(orphan.1, None);
        assert_eq!(orphan.2, None);
        assert!(orphan.3.is_some());
        close_test_pool(path, pool).await;
    }

    #[tokio::test]
    async fn persists_research_terminal_without_a_window() {
        let (path, pool) = test_pool("research-terminal").await;
        sqlx::query("INSERT INTO documents (id, title, content_json, plain_text, revision, created_at, updated_at) VALUES ('doc-1', 'Source', '{\"type\":\"doc\",\"content\":[]}', '', 2, 1, 1)")
            .execute(pool.as_ref()).await.expect("insert document");
        sqlx::query("INSERT INTO agent_requests (id, prompt, mode, status, run_id, cognitive_session_id, created_at, updated_at) VALUES ('request-1', 'Research', 'research', 'running', 'run-1', 'session-1', 1, 1)")
            .execute(pool.as_ref()).await.expect("insert request");
        create_background_cognitive_session(
            pool.as_ref(),
            "session-1",
            "conversation-1",
            "research",
            "doc-1",
        )
        .await
        .expect("create session");
        let structured = json!({
            "summary": "Found one fact", "relations": [], "unresolvedQuestions": [],
            "items": [{ "id": "item-1", "kind": "fact", "title": "Fact", "content": "Content", "confidence": 0.8, "validationStatus": "verified", "validationMessage": "Located", "sources": [{ "documentId": "doc-1", "blockId": null, "revision": 2, "quote": "Body" }] }]
        });
        let recovery = json!({ "kind": "a2a", "requestId": "request-1", "runId": "run-1", "cognitiveSessionId": "session-1", "intent": "research" });
        let terminal = json!({ "structuredOutput": structured });
        settle_background_run(pool.as_ref(), &recovery, None, Some(&terminal), None, false)
            .await
            .expect("settle run");
        settle_background_run(pool.as_ref(), &recovery, None, Some(&terminal), None, false)
            .await
            .expect("repeat terminal is idempotent");
        let request_status: String =
            sqlx::query_scalar("SELECT status FROM agent_requests WHERE id = 'request-1'")
                .fetch_one(pool.as_ref())
                .await
                .expect("request status");
        let session_status: String =
            sqlx::query_scalar("SELECT status FROM cognitive_sessions WHERE id = 'session-1'")
                .fetch_one(pool.as_ref())
                .await
                .expect("session status");
        let candidates: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_objects WHERE cognitive_mode = 'research' AND status = 'candidate'")
            .fetch_one(pool.as_ref()).await.expect("candidate count");
        let generated_run_id: String =
            sqlx::query_scalar("SELECT generated_run_id FROM knowledge_objects LIMIT 1")
                .fetch_one(pool.as_ref())
                .await
                .expect("candidate provenance");
        assert_eq!(request_status, "completed");
        assert_eq!(session_status, "completed");
        assert_eq!(candidates, 1);
        assert_eq!(generated_run_id, "run-1");
        close_test_pool(path, pool).await;
    }

    #[tokio::test]
    async fn stale_background_terminal_cannot_settle_a_new_run() {
        let (path, pool) = test_pool("stale-background-terminal").await;
        sqlx::query("INSERT INTO agent_requests (id, prompt, status, run_id, attempt_count, created_at, updated_at) VALUES ('request-1', 'Retry', 'running', 'run-new', 2, 1, 1)")
            .execute(pool.as_ref()).await.expect("insert request");
        let stale = json!({ "kind": "a2a", "requestId": "request-1", "runId": "run-old", "leaseOwner": "lease-old", "intent": "agent" });
        settle_background_run(
            pool.as_ref(),
            &stale,
            None,
            Some(&json!({ "structuredOutput": null })),
            None,
            false,
        )
        .await
        .expect("ignore stale success");
        settle_background_run(
            pool.as_ref(),
            &stale,
            None,
            None,
            Some("late provider failure"),
            true,
        )
        .await
        .expect("ignore stale failure");

        let state: (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT status, run_id, result_json FROM agent_requests WHERE id = 'request-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("read request");
        assert_eq!(
            state,
            ("running".to_string(), Some("run-new".to_string()), None)
        );
        close_test_pool(path, pool).await;
    }

    #[tokio::test]
    async fn data_migration_quiesce_aborts_watcher_and_preserves_its_directory() {
        struct DropSignal(std::sync::Arc<AtomicBool>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let state = AgentRequestWatcherState::default();
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

    async fn test_pool(label: &str) -> (std::path::PathBuf, std::sync::Arc<SqlitePool>) {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-{label}-{}-{}.db",
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

    async fn close_test_pool(path: std::path::PathBuf, pool: std::sync::Arc<SqlitePool>) {
        drop(pool);
        database::close_pool(&path).await.expect("close database");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
