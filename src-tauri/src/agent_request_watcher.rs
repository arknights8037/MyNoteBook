use serde::{Deserialize, Serialize};
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
}
