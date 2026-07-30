use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, State};
use tokio::{sync::Mutex, task::JoinHandle, time::Duration};

use crate::database;

const QUEUE_EVENT: &str = "agent-communication://queue-changed";

#[derive(Default)]
pub(crate) struct AgentRequestWatcherState {
    task: Mutex<Option<JoinHandle<()>>>,
    data_directory: Mutex<Option<String>>,
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
         result_json = COALESCE(?, result_json), updated_at = ?, completed_at = ? WHERE id = ?",
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
    let stale_before = now_millis() - 50 * 60 * 1_000;
    let mut transaction = connection.begin().await.map_err(database::database_error)?;
    let row = if let Some(task_id) = previous_task_id {
        sqlx::query(
            "SELECT request.*, branch.title AS branch_title, branch.parent_conversation_id \
             FROM agent_requests request LEFT JOIN agent_branches branch ON branch.id = request.branch_id \
             WHERE request.previous_task_id = ? AND (request.status = 'queued' OR \
             (request.status = 'running' AND request.task_id IS NULL AND request.updated_at < ?)) \
             ORDER BY request.updated_at ASC LIMIT 1",
        )
        .bind(task_id)
        .bind(stale_before)
        .fetch_optional(&mut *transaction)
        .await
    } else {
        sqlx::query(
            "SELECT request.*, branch.title AS branch_title, branch.parent_conversation_id \
             FROM agent_requests request LEFT JOIN agent_branches branch ON branch.id = request.branch_id \
             WHERE request.previous_task_id IS NULL AND (request.status = 'queued' OR \
             (request.status = 'running' AND request.task_id IS NULL AND request.updated_at < ?)) \
             ORDER BY request.created_at ASC LIMIT 1",
        )
        .bind(stale_before)
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
        "UPDATE agent_requests SET status = 'running', updated_at = ? WHERE id = ? AND \
         (status = 'queued' OR (status = 'running' AND task_id IS NULL AND updated_at < ?))",
    )
    .bind(now_millis())
    .bind(&id)
    .bind(stale_before)
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
    let same_directory = *state.data_directory.lock().await == requested_directory;
    let mut task = state.task.lock().await;
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

async fn watch_agent_requests(app: AppHandle, data_directory: Option<String>) {
    let mut last_snapshot: Option<(i64, Option<i64>)> = None;
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    loop {
        ticker.tick().await;
        let Ok(connection) = database::open_database(&app, data_directory.clone()).await else {
            continue;
        };
        let Ok((actionable_count, latest_update_at)) =
            read_queue_snapshot(connection.as_ref()).await
        else {
            continue;
        };
        let signature = (actionable_count, latest_update_at);
        if actionable_count > 0 || last_snapshot.as_ref() != Some(&signature) {
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

async fn read_queue_snapshot(connection: &SqlitePool) -> Result<(i64, Option<i64>), String> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS actionable_count, MAX(updated_at) AS latest_update_at \
         FROM agent_requests WHERE status IN ('queued', 'approved', 'rejected', 'failed')",
    )
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

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
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
}
