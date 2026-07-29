use sqlx::SqlitePool;

/// Phase 2 crash boundary: the future Rust-owned worker supervisor calls this
/// after an unexpected Node/PI exit. Only runs that were still executing are
/// transitioned; completed and review-waiting runs remain untouched.
pub(crate) async fn handle_pi_worker_exit(
    connection: &SqlitePool,
    active_run_ids: &[String],
    exit_description: &str,
    interrupted_at: i64,
) -> Result<usize, String> {
    if active_run_ids.is_empty() {
        return Ok(0);
    }
    let error = format!("PI Worker interrupted: {exit_description}");
    let mut transaction = connection.begin().await.map_err(database_error)?;
    let mut updated = 0usize;
    for run_id in active_run_ids {
        let result = sqlx::query(
            "UPDATE agent_tasks \
             SET status = 'interrupted', current_step = 'PI Worker 意外退出', \
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

    #[tokio::test]
    async fn worker_crash_marks_only_active_runs_interrupted() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-pi-worker-crash-{}-{}.db",
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

        let updated = handle_pi_worker_exit(
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
