use serde::Serialize;
use sqlx::{migrate::Migrator, sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub const DATABASE_URL: &str = "sqlite:editor.db";
pub const DATABASE_FILENAME: &str = "editor.db";
static DATABASE_MIGRATOR: Migrator = sqlx::migrate!("./migrations");
static DATABASE_POOLS: OnceLock<Mutex<HashMap<PathBuf, Arc<SqlitePool>>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePreparation {
    database_path: String,
    backup_path: Option<String>,
    legacy_baseline_version: Option<i64>,
}

#[tauri::command]
pub async fn prepare_database(
    app: AppHandle,
    data_directory: Option<String>,
) -> Result<DatabasePreparation, String> {
    let directory = configured_data_directory(&app, data_directory).map_err(database_error)?;
    fs::create_dir_all(&directory).map_err(database_error)?;
    let database_path = directory.join(DATABASE_FILENAME);
    let existed = database_path.is_file();
    let pool = get_pool_for_path(&database_path, true).await?;
    let legacy_baseline_version = detect_legacy_baseline(&pool).await?;
    let backup_path = if existed && database_needs_migration(&pool).await? {
        Some(backup_database(&pool, &database_path).await?)
    } else {
        None
    };

    if let Some(version) = legacy_baseline_version {
        baseline_legacy_database(&pool, version).await?;
    }
    DATABASE_MIGRATOR
        .run(pool.as_ref())
        .await
        .map_err(database_error)?;
    optimize_database(pool.as_ref()).await?;

    Ok(DatabasePreparation {
        database_path: database_path.to_string_lossy().into_owned(),
        backup_path: backup_path.map(|path| path.to_string_lossy().into_owned()),
        legacy_baseline_version,
    })
}

pub async fn open_database(
    app: &AppHandle,
    data_directory: Option<String>,
) -> Result<Arc<SqlitePool>, String> {
    let path = configured_data_directory(app, data_directory)
        .map_err(database_error)?
        .join(DATABASE_FILENAME);
    get_pool_for_path(&path, false).await
}

pub async fn get_pool_for_path(
    path: &Path,
    create_if_missing: bool,
) -> Result<Arc<SqlitePool>, String> {
    let key = path.to_path_buf();
    if let Some(pool) = pools().lock().map_err(database_error)?.get(&key).cloned() {
        return Ok(pool);
    }

    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&key)
        .create_if_missing(create_if_missing)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);
    let pool = Arc::new(
        SqlitePoolOptions::new()
            .max_connections(4)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .idle_timeout(Duration::from_secs(120))
            .connect_with(options)
            .await
            .map_err(database_error)?,
    );
    pools()
        .lock()
        .map_err(database_error)?
        .insert(key, Arc::clone(&pool));
    Ok(pool)
}

pub async fn close_pool(path: &Path) -> Result<(), String> {
    let pool = pools().lock().map_err(database_error)?.remove(path);
    if let Some(pool) = pool {
        pool.close().await;
    }
    Ok(())
}

pub fn default_data_directory(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    app.path().app_config_dir()
}

pub fn configured_data_directory(
    app: &AppHandle,
    data_directory: Option<String>,
) -> Result<PathBuf, tauri::Error> {
    Ok(data_directory
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_data_directory(app)?))
}

pub fn database_error(error: impl std::fmt::Display) -> String {
    format!("数据库事务失败：{error}")
}

fn pools() -> &'static Mutex<HashMap<PathBuf, Arc<SqlitePool>>> {
    DATABASE_POOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn detect_legacy_baseline(pool: &SqlitePool) -> Result<Option<i64>, String> {
    if table_exists(pool, "_sqlx_migrations").await? || !table_exists(pool, "documents").await? {
        return Ok(None);
    }
    let mut version = 1;
    if column_exists(pool, "documents", "document_kind").await? {
        version = 2;
    }
    if column_exists(pool, "documents", "source_url").await?
        && column_exists(pool, "assets", "content_hash").await?
        && table_exists(pool, "tags").await?
        && table_exists(pool, "document_tags").await?
    {
        version = 3;
    }
    if table_exists(pool, "agent_tasks").await? && table_exists(pool, "document_search").await? {
        version = 4;
    }
    if table_exists(pool, "agent_tool_calls").await? {
        version = 5;
    }
    if table_exists(pool, "blocks").await? {
        version = 6;
    }
    if table_exists(pool, "agent_document_creation_transactions").await? {
        version = 7;
    }
    if table_exists(pool, "automation_tasks").await?
        && table_exists(pool, "automation_runs").await?
    {
        version = 8;
    }
    if table_exists(pool, "context_bundles").await?
        && column_exists(pool, "agent_tasks", "execution_policy_json").await?
    {
        version = 9;
    }
    if table_exists(pool, "knowledge_objects").await?
        && table_exists(pool, "task_runs").await?
        && table_exists(pool, "view_definitions").await?
    {
        version = 10;
    }
    Ok(Some(version))
}

async fn baseline_legacy_database(pool: &SqlitePool, version: i64) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (\
         version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
         success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)",
    )
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    for migration in DATABASE_MIGRATOR
        .iter()
        .filter(|migration| migration.version <= version)
    {
        sqlx::query(
            "INSERT OR IGNORE INTO _sqlx_migrations \
             (version, description, success, checksum, execution_time) VALUES (?, ?, TRUE, ?, 0)",
        )
        .bind(migration.version)
        .bind(migration.description.as_ref())
        .bind(migration.checksum.as_ref())
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    transaction.commit().await.map_err(database_error)
}

async fn database_needs_migration(pool: &SqlitePool) -> Result<bool, String> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(table_exists(pool, "documents").await?);
    }
    let installed: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = TRUE",
    )
    .fetch_one(pool)
    .await
    .map_err(database_error)?;
    Ok(installed
        < DATABASE_MIGRATOR
            .iter()
            .map(|migration| migration.version)
            .max()
            .unwrap_or(0))
}

async fn table_exists(pool: &SqlitePool, table: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)",
    )
    .bind(table)
    .fetch_one(pool)
    .await
    .map(|value| value == 1)
    .map_err(database_error)
}

async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> Result<bool, String> {
    let rows = sqlx::query(&format!(
        "PRAGMA table_info(\"{}\")",
        table.replace('"', "\"\"")
    ))
    .fetch_all(pool)
    .await
    .map_err(database_error)?;
    Ok(rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == column)
    }))
}

async fn backup_database(pool: &SqlitePool, database_path: &Path) -> Result<PathBuf, String> {
    sqlx::query("PRAGMA wal_checkpoint(FULL)")
        .execute(pool)
        .await
        .map_err(database_error)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(database_error)?
        .as_secs();
    let backup_path = database_path.with_file_name(format!("editor-pre-migration-{timestamp}.db"));
    fs::copy(database_path, &backup_path).map_err(database_error)?;
    Ok(backup_path)
}

async fn optimize_database(pool: &SqlitePool) -> Result<(), String> {
    for statement in [
        "PRAGMA foreign_keys = ON",
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA temp_store = MEMORY",
        "PRAGMA optimize",
    ] {
        sqlx::query(statement)
            .execute(pool)
            .await
            .map_err(database_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fresh_database_reaches_current_schema() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-p0-schema-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = get_pool_for_path(&path, true).await.expect("open database");
        DATABASE_MIGRATOR.run(pool.as_ref()).await.expect("migrate");
        assert!(table_exists(pool.as_ref(), "context_bundles")
            .await
            .expect("context bundle table"));
        assert!(
            column_exists(pool.as_ref(), "agent_tasks", "execution_policy_json")
                .await
                .expect("execution policy column")
        );
        assert!(
            column_exists(pool.as_ref(), "agent_tool_calls", "correlation_id")
                .await
                .expect("tool correlation column")
        );
        assert!(table_exists(pool.as_ref(), "knowledge_objects")
            .await
            .expect("knowledge table"));
        assert!(table_exists(pool.as_ref(), "task_runs")
            .await
            .expect("task run table"));
        assert!(table_exists(pool.as_ref(), "view_definitions")
            .await
            .expect("view table"));
        drop(pool);
        close_pool(&path).await.expect("close database");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn p0_migration_upgrades_an_existing_v8_schema() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-v8-upgrade-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = get_pool_for_path(&path, true).await.expect("open database");
        for sql in [
            include_str!("../migrations/0001_create_documents_and_assets.sql"),
            include_str!("../migrations/0002_add_document_kind.sql"),
            include_str!("../migrations/0003_add_assets_tags_and_document_metadata.sql"),
            include_str!("../migrations/0004_add_agent_audit_and_document_search.sql"),
            include_str!("../migrations/0005_add_agent_tool_calls.sql"),
            include_str!("../migrations/0006_add_document_blocks.sql"),
            include_str!("../migrations/0007_add_agent_document_creation.sql"),
            include_str!("../migrations/0008_add_automations.sql"),
        ] {
            sqlx::raw_sql(sql)
                .execute(pool.as_ref())
                .await
                .expect("build v8 schema");
        }
        sqlx::query(
            "INSERT INTO agent_tasks (id, session_id, document_id, status, user_instruction, \
             context_scope, model, current_step, created_at) \
             VALUES ('legacy-task', 'doc', 'doc', 'completed', 'legacy', \
             'current_document', 'model', 'done', 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("legacy task");
        sqlx::raw_sql(include_str!(
            "../migrations/0009_add_p0_trusted_runtime.sql"
        ))
        .execute(pool.as_ref())
        .await
        .expect("upgrade to v9");
        let correlation_id: String =
            sqlx::query_scalar("SELECT correlation_id FROM agent_tasks WHERE id = 'legacy-task'")
                .fetch_one(pool.as_ref())
                .await
                .expect("backfilled correlation id");
        assert_eq!(correlation_id, "legacy-task");
        assert!(table_exists(pool.as_ref(), "context_bundles")
            .await
            .expect("context bundle table"));
        drop(pool);
        close_pool(&path).await.expect("close database");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn p1_migration_maps_existing_work_and_marks_views_stale() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-v9-upgrade-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = get_pool_for_path(&path, true).await.expect("open database");
        for sql in [
            include_str!("../migrations/0001_create_documents_and_assets.sql"),
            include_str!("../migrations/0002_add_document_kind.sql"),
            include_str!("../migrations/0003_add_assets_tags_and_document_metadata.sql"),
            include_str!("../migrations/0004_add_agent_audit_and_document_search.sql"),
            include_str!("../migrations/0005_add_agent_tool_calls.sql"),
            include_str!("../migrations/0006_add_document_blocks.sql"),
            include_str!("../migrations/0007_add_agent_document_creation.sql"),
            include_str!("../migrations/0008_add_automations.sql"),
            include_str!("../migrations/0009_add_p0_trusted_runtime.sql"),
        ] {
            sqlx::raw_sql(sql)
                .execute(pool.as_ref())
                .await
                .expect("build v9 schema");
        }
        sqlx::query(
            "INSERT INTO documents (id, parent_id, document_kind, title, content_json, plain_text, \
             schema_version, revision, sort_order, is_deleted, created_at, updated_at) \
             VALUES ('doc-1', NULL, 'article', 'Doc', \
             '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"attrs\":{\"id\":\"b1\"}}]}', \
             '', 2, 1, 0, 0, 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("document");
        sqlx::query(
            "INSERT INTO automation_tasks (id, name, instruction, trigger_type, trigger_config_json, \
             enabled, created_at, updated_at) VALUES ('auto-1', 'Auto', 'Do work', 'manual', '{}', 1, 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("automation");
        sqlx::query(
            "INSERT INTO automation_runs (id, automation_id, trigger_source, status, input_json, queued_at, correlation_id) \
             VALUES ('auto-run-1', 'auto-1', 'manual', 'queued', '{}', 2, 'corr-auto')",
        )
        .execute(pool.as_ref())
        .await
        .expect("automation run");
        sqlx::query(
            "INSERT INTO agent_tasks (id, session_id, document_id, status, user_instruction, context_scope, \
             model, current_step, created_at, correlation_id) VALUES \
             ('agent-1', 'doc-1', 'doc-1', 'waiting_confirmation', 'Update', 'current_document', \
              'model', 'Waiting', 3, 'corr-agent')",
        )
        .execute(pool.as_ref())
        .await
        .expect("agent task");
        sqlx::query(
            "INSERT INTO agent_patch_sets (task_id, model, created_at) VALUES ('agent-1', 'model', 4)",
        )
        .execute(pool.as_ref())
        .await
        .expect("patch set");
        sqlx::raw_sql(include_str!(
            "../migrations/0010_add_p1_knowledge_work_views.sql"
        ))
        .execute(pool.as_ref())
        .await
        .expect("upgrade to v10");
        let mapped_definitions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM task_definitions WHERE automation_id = 'auto-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("mapped definition");
        let mapped_runs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM task_runs WHERE id IN ('taskrun-automation-auto-run-1', 'taskrun-agent-agent-1')",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("mapped runs");
        let mapped_change_sets: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM change_sets WHERE agent_task_id = 'agent-1'")
                .fetch_one(pool.as_ref())
                .await
                .expect("mapped change set");
        assert_eq!(mapped_definitions, 1);
        assert_eq!(mapped_runs, 2);
        assert_eq!(mapped_change_sets, 1);

        sqlx::query(
            "INSERT INTO view_definitions (id, name, view_type, scope_query_json, render_spec_json, \
             writeback_policy, stale, version, current_snapshot_id, created_at, updated_at) \
             VALUES ('view-1', 'View', 'query', '{}', '{}', 'readonly', 0, 1, 'snapshot-1', 5, 5)",
        )
        .execute(pool.as_ref())
        .await
        .expect("view");
        sqlx::query(
            "INSERT INTO view_snapshots (id, view_id, status, source_snapshot_hash, render_json, created_at) \
             VALUES ('snapshot-1', 'view-1', 'fresh', 'hash', '{}', 5)",
        )
        .execute(pool.as_ref())
        .await
        .expect("snapshot");
        sqlx::query(
            "INSERT INTO view_dependencies (snapshot_id, view_id, source_type, document_id, source_revision) \
             VALUES ('snapshot-1', 'view-1', 'document_block', 'doc-1', 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("dependency");
        sqlx::query("UPDATE documents SET revision = 2, updated_at = 6 WHERE id = 'doc-1'")
            .execute(pool.as_ref())
            .await
            .expect("document update");
        let stale: i64 =
            sqlx::query_scalar("SELECT stale FROM view_definitions WHERE id = 'view-1'")
                .fetch_one(pool.as_ref())
                .await
                .expect("stale view");
        assert_eq!(stale, 1);
        sqlx::raw_sql(include_str!(
            "../migrations/0011_add_p2_external_governance_generated_views.sql"
        ))
        .execute(pool.as_ref())
        .await
        .expect("upgrade to v11");
        let preserved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM view_dependencies WHERE snapshot_id = 'snapshot-1' AND view_id = 'view-1'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("preserved P1 dependency");
        assert_eq!(preserved, 1);
        sqlx::query(
            "INSERT INTO view_definitions (id, name, view_type, scope_query_json, render_spec_json, \
             writeback_policy, generation_prompt, generation_provider, generation_model, stale, \
             version, created_at, updated_at) VALUES \
             ('generated-1', 'Generated', 'generated', '{}', '{}', 'readonly', 'summarize', \
              'openai', 'gpt-5-mini', 1, 1, 7, 7)",
        )
        .execute(pool.as_ref())
        .await
        .expect("generated view");
        for table in [
            "delegations",
            "idempotency_records",
            "domain_events",
            "outbox_messages",
            "external_submissions",
        ] {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(pool.as_ref())
            .await
            .expect("P2 table");
            assert_eq!(exists, 1, "missing {table}");
        }
        drop(pool);
        close_pool(&path).await.expect("close database");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }
}
