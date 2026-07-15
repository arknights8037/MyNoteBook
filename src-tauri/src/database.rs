use serde::Serialize;
use sqlx::{migrate::Migrator, sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

pub const DATABASE_URL: &str = "sqlite:editor.db";
pub const DATABASE_FILENAME: &str = "editor.db";
pub(crate) static DATABASE_MIGRATOR: Migrator = sqlx::migrate!("./migrations");
static DATABASE_POOLS: OnceLock<Mutex<HashMap<PathBuf, Arc<SqlitePool>>>> = OnceLock::new();

#[derive(Debug, Serialize)]
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
    prepare_database_path(&directory, &DATABASE_MIGRATOR).await
}

pub(crate) async fn prepare_database_path(
    directory: &Path,
    migrator: &Migrator,
) -> Result<DatabasePreparation, String> {
    fs::create_dir_all(&directory).map_err(database_error)?;
    let database_path = directory.join(DATABASE_FILENAME);
    let existed = database_path.is_file();
    let pool = get_pool_for_path(&database_path, true).await?;
    let legacy_baseline_version = detect_legacy_baseline(&pool).await?;
    let backup_path = if existed && database_needs_migration(&pool, migrator).await? {
        Some(backup_database(&pool, &database_path).await?)
    } else {
        None
    };

    let preparation_result = async {
        if let Some(version) = legacy_baseline_version {
            baseline_legacy_database(&pool, version, migrator).await?;
        }
        migrator.run(pool.as_ref()).await.map_err(database_error)?;
        optimize_database(pool.as_ref()).await?;
        cleanup_orphan_asset_files(pool.as_ref(), &directory).await?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = preparation_result {
        drop(pool);
        close_pool(&database_path).await?;
        if let Some(backup_path) = &backup_path {
            restore_database_backup(&database_path, backup_path)?;
            return Err(format!(
                "{error}；已从升级前备份恢复数据库：{}",
                backup_path.display()
            ));
        }
        return Err(error);
    }

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
    let mut pools = pools().lock().await;
    if let Some(pool) = pools.get(&key).cloned() {
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
    pools.insert(key, Arc::clone(&pool));
    Ok(pool)
}

pub async fn close_pool(path: &Path) -> Result<(), String> {
    let pool = pools().lock().await.remove(path);
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
    if table_exists(pool, "delegations").await?
        && table_exists(pool, "domain_events").await?
        && column_exists(pool, "view_definitions", "generation_prompt").await?
    {
        version = 11;
    }
    if column_exists(
        pool,
        "agent_document_creation_transactions",
        "child_document_id",
    )
    .await?
    {
        version = 12;
    }
    Ok(Some(version))
}

async fn baseline_legacy_database(
    pool: &SqlitePool,
    version: i64,
    migrator: &Migrator,
) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (\
         version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
         success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)",
    )
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    for migration in migrator
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

async fn database_needs_migration(pool: &SqlitePool, migrator: &Migrator) -> Result<bool, String> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return table_exists(pool, "documents").await;
    }
    let installed: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = TRUE",
    )
    .fetch_one(pool)
    .await
    .map_err(database_error)?;
    Ok(installed
        < migrator
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
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(database_error)?
        .as_nanos();
    let backup_path = database_path.with_file_name(format!("editor-pre-migration-{timestamp}.db"));
    // VACUUM INTO uses SQLite's snapshot machinery, so concurrent WAL writers cannot produce a
    // torn filesystem copy. The destination is timestamp-unique and must not already exist.
    sqlx::query("VACUUM INTO ?")
        .bind(backup_path.to_string_lossy().as_ref())
        .execute(pool)
        .await
        .map_err(database_error)?;
    Ok(backup_path)
}

fn restore_database_backup(database_path: &Path, backup_path: &Path) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(database_error)?
        .as_nanos();
    let restore_path = database_path.with_file_name(format!("editor-restore-{timestamp}.db"));
    fs::copy(backup_path, &restore_path).map_err(database_error)?;
    fs::OpenOptions::new()
        .write(true)
        .open(&restore_path)
        .and_then(|file| file.sync_all())
        .map_err(database_error)?;

    for sidecar in [
        database_path.with_extension("db-wal"),
        database_path.with_extension("db-shm"),
    ] {
        remove_file_if_present(&sidecar)?;
    }
    remove_file_if_present(database_path)?;
    if let Err(error) = retry_file_operation(|| fs::rename(&restore_path, database_path)) {
        let fallback = retry_file_operation(|| fs::copy(backup_path, database_path).map(|_| ()));
        let _ = fs::remove_file(&restore_path);
        fallback.map_err(|fallback_error| {
            database_error(format!(
                "无法启用恢复数据库：{error}；直接恢复也失败：{fallback_error}"
            ))
        })?;
    }
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match retry_file_operation(|| fs::remove_file(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(database_error(error)),
    }
}

fn retry_file_operation(mut operation: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut last_error = None;
    for _ in 0..20 {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(error),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(last_error.expect("file operation must record an error"))
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

async fn cleanup_orphan_asset_files(
    pool: &SqlitePool,
    data_directory: &Path,
) -> Result<(), String> {
    if !table_exists(pool, "assets").await? {
        return Ok(());
    }
    let referenced = sqlx::query_scalar::<_, String>("SELECT relative_path FROM assets")
        .fetch_all(pool)
        .await
        .map_err(database_error)?
        .into_iter()
        .collect::<HashSet<_>>();
    let assets_directory = data_directory.join("assets");
    let entries = match fs::read_dir(&assets_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(database_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(database_error)?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let relative_path = format!("assets/{}", entry.file_name().to_string_lossy());
        if !referenced.contains(&relative_path) {
            fs::remove_file(path).map_err(database_error)?;
        }
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
        assert!(table_exists(pool.as_ref(), "cognitive_sessions")
            .await
            .expect("cognitive sessions table"));
        assert!(table_exists(pool.as_ref(), "knowledge_object_sources")
            .await
            .expect("knowledge sources table"));
        assert!(table_exists(pool.as_ref(), "knowledge_validations")
            .await
            .expect("knowledge validations table"));
        let block_trigger_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'blocks_after_document_%'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("block triggers");
        assert_eq!(block_trigger_count, 0);
        sqlx::query(
            "INSERT INTO documents (id, title, content_json, created_at, updated_at) \
             VALUES ('asset-doc', 'Asset', '{\"type\":\"doc\",\"content\":[]}', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("asset document");
        sqlx::query(
            "INSERT INTO assets (id, document_id, relative_path, original_name, mime_type, \
             size_bytes, created_at) VALUES ('asset-1', 'asset-doc', 'assets/a.txt', 'a.txt', \
             'text/plain', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("asset");
        sqlx::query("DELETE FROM documents WHERE id = 'asset-doc'")
            .execute(pool.as_ref())
            .await
            .expect("delete asset document");
        let asset_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE id = 'asset-1'")
                .fetch_one(pool.as_ref())
                .await
                .expect("asset cascade");
        assert_eq!(asset_count, 0);
        sqlx::query(
            "INSERT INTO automation_tasks (id, name, instruction, trigger_type, created_at, updated_at) \
             VALUES ('guard-auto', 'Guard', 'Run', 'manual', 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("guard automation");
        sqlx::query(
            "INSERT INTO automation_runs (id, automation_id, trigger_source, status, queued_at) \
             VALUES ('guard-run', 'guard-auto', 'manual', 'queued', 2)",
        )
        .execute(pool.as_ref())
        .await
        .expect("guard run");
        assert!(sqlx::query(
            "UPDATE task_runs SET status = 'completed' WHERE id = 'taskrun-automation-guard-run'"
        )
        .execute(pool.as_ref())
        .await
        .is_err());
        sqlx::query(
            "UPDATE automation_runs SET status = 'completed', completed_at = 3 WHERE id = 'guard-run'",
        )
        .execute(pool.as_ref())
        .await
        .expect("source status update");
        let projected_status: String = sqlx::query_scalar(
            "SELECT status FROM task_runs WHERE id = 'taskrun-automation-guard-run'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("projected status");
        assert_eq!(projected_status, "completed");
        drop(pool);
        close_pool(&path).await.expect("close database");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn legacy_v11_schema_is_detected_before_new_migrations_run() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-v11-baseline-{}-{}.db",
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
            include_str!("../migrations/0010_add_p1_knowledge_work_views.sql"),
            include_str!("../migrations/0011_add_p2_external_governance_generated_views.sql"),
        ] {
            sqlx::raw_sql(sql)
                .execute(pool.as_ref())
                .await
                .expect("build v11 schema");
        }
        assert_eq!(
            detect_legacy_baseline(pool.as_ref()).await.unwrap(),
            Some(11)
        );
        baseline_legacy_database(pool.as_ref(), 11, &DATABASE_MIGRATOR)
            .await
            .expect("baseline v11");
        DATABASE_MIGRATOR
            .run(pool.as_ref())
            .await
            .expect("run v12 and v13");
        assert!(column_exists(
            pool.as_ref(),
            "agent_document_creation_transactions",
            "child_document_id"
        )
        .await
        .unwrap());
        drop(pool);
        close_pool(&path).await.expect("close database");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn migration_backup_uses_a_readable_sqlite_snapshot() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-backup-source-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let pool = get_pool_for_path(&path, true).await.expect("open database");
        sqlx::query("CREATE TABLE snapshot_probe (value TEXT NOT NULL)")
            .execute(pool.as_ref())
            .await
            .expect("create probe");
        sqlx::query("INSERT INTO snapshot_probe VALUES ('complete')")
            .execute(pool.as_ref())
            .await
            .expect("insert probe");
        let backup_path = backup_database(pool.as_ref(), &path).await.expect("backup");
        let backup = get_pool_for_path(&backup_path, false)
            .await
            .expect("open backup");
        let value: String = sqlx::query_scalar("SELECT value FROM snapshot_probe")
            .fetch_one(backup.as_ref())
            .await
            .expect("read backup");
        assert_eq!(value, "complete");
        drop(backup);
        drop(pool);
        close_pool(&backup_path).await.expect("close backup");
        close_pool(&path).await.expect("close source");
        let _ = fs::remove_file(&backup_path);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn failed_migration_restores_the_pre_migration_snapshot() {
        let root = std::env::temp_dir().join(format!(
            "my-notebook-failed-migration-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let migrations = root.join("migrations");
        fs::create_dir_all(&migrations).expect("migration directory");
        fs::write(
            migrations.join("0001_fail.sql"),
            "CREATE TABLE should_be_rolled_back (id INTEGER); THIS IS NOT SQL;",
        )
        .expect("failing migration");

        let path = root.join(DATABASE_FILENAME);
        let pool = get_pool_for_path(&path, true).await.expect("open database");
        sqlx::query("CREATE TABLE snapshot_probe (value TEXT NOT NULL)")
            .execute(pool.as_ref())
            .await
            .expect("probe table");
        sqlx::query("INSERT INTO snapshot_probe VALUES ('before-migration')")
            .execute(pool.as_ref())
            .await
            .expect("probe value");
        sqlx::query(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, \
             installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, \
             checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)",
        )
        .execute(pool.as_ref())
        .await
        .expect("migration table");
        drop(pool);
        close_pool(&path).await.expect("close source");

        let failing_migrator = Migrator::new(migrations.as_path())
            .await
            .expect("load failing migrator");
        let error = prepare_database_path(&root, &failing_migrator)
            .await
            .expect_err("migration must fail");
        assert!(
            error.contains("已从升级前备份恢复数据库"),
            "unexpected migration error: {error}"
        );

        let restored = get_pool_for_path(&path, false)
            .await
            .expect("open restored database");
        let value: String = sqlx::query_scalar("SELECT value FROM snapshot_probe")
            .fetch_one(restored.as_ref())
            .await
            .expect("read restored value");
        assert_eq!(value, "before-migration");
        assert!(!table_exists(restored.as_ref(), "should_be_rolled_back")
            .await
            .expect("partial table check"));
        drop(restored);
        close_pool(&path).await.expect("close restored database");
        assert!(fs::read_dir(&root)
            .expect("read root")
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("editor-pre-migration-")));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[tokio::test]
    #[ignore = "requires MYNOTEBOOK_SMOKE_SOURCE_DB pointing to a copied Windows database"]
    async fn windows_copied_database_smoke() {
        let source = PathBuf::from(
            std::env::var("MYNOTEBOOK_SMOKE_SOURCE_DB").expect("smoke source database path"),
        );
        assert!(source.is_file(), "smoke source database is missing");
        let root = std::env::temp_dir().join(format!(
            "my-notebook-copied-database-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("smoke directory");
        let path = root.join(DATABASE_FILENAME);
        fs::copy(&source, &path).expect("copy smoke database");

        let before = get_pool_for_path(&path, false)
            .await
            .expect("open copied database");
        let document_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
            .fetch_one(before.as_ref())
            .await
            .expect("count source documents");
        drop(before);
        close_pool(&path).await.expect("close copied database");

        let preparation = prepare_database_path(&root, &DATABASE_MIGRATOR)
            .await
            .expect("upgrade copied database");
        assert!(preparation.backup_path.is_some());
        let upgraded = get_pool_for_path(&path, false)
            .await
            .expect("open upgraded database");
        let current_version: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = TRUE",
        )
        .fetch_one(upgraded.as_ref())
        .await
        .expect("migration version");
        let document_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
            .fetch_one(upgraded.as_ref())
            .await
            .expect("count upgraded documents");
        let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(upgraded.as_ref())
            .await
            .expect("quick check");
        let foreign_key_errors = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(upgraded.as_ref())
            .await
            .expect("foreign key check");
        assert_eq!(current_version, 14);
        assert_eq!(document_count_after, document_count_before);
        assert_eq!(integrity, "ok");
        assert!(foreign_key_errors.is_empty());

        drop(upgraded);
        close_pool(&path).await.expect("close upgraded database");
        fs::remove_dir_all(&root).expect("cleanup smoke directory");
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

    #[tokio::test]
    async fn cognitive_migration_preserves_existing_knowledge_links() {
        let path = std::env::temp_dir().join(format!(
            "my-notebook-v13-cognitive-upgrade-{}-{}.db",
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
            include_str!("../migrations/0010_add_p1_knowledge_work_views.sql"),
            include_str!("../migrations/0011_add_p2_external_governance_generated_views.sql"),
            include_str!("../migrations/0012_add_agent_group_creation.sql"),
            include_str!("../migrations/0013_harden_database_operations.sql"),
        ] {
            sqlx::raw_sql(sql)
                .execute(pool.as_ref())
                .await
                .expect("build v13 schema");
        }
        sqlx::query(
            "INSERT INTO documents (id, title, content_json, plain_text, schema_version, revision, created_at, updated_at) \
             VALUES ('doc-cognitive', 'Doc', '{\"type\":\"doc\",\"content\":[]}', '', 2, 3, 1, 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("document");
        for (id, object_type) in [("rule-old", "rule"), ("decision-old", "decision")] {
            sqlx::query(
                "INSERT INTO knowledge_objects (id, object_type, status, title, scope_json, document_id, \
                 block_id, source_revision, authority_level, version, created_at, updated_at) \
                 VALUES (?, ?, 'approved', ?, '{}', 'doc-cognitive', 'block-1', 3, 'local', 1, 2, 2)",
            )
            .bind(id)
            .bind(object_type)
            .bind(id)
            .execute(pool.as_ref())
            .await
            .expect("knowledge object");
        }
        sqlx::query(
            "INSERT INTO knowledge_object_relations VALUES \
             ('relation-old', 'decision-old', 'supports', 'rule-old', 3)",
        )
        .execute(pool.as_ref())
        .await
        .expect("relation");
        sqlx::query(
            "INSERT INTO task_definitions (id, definition_type, name, instruction, acceptance_criteria_json, \
             execution_policy_json, source_knowledge_object_id, enabled, version, created_at, updated_at) \
             VALUES ('definition-old', 'knowledge', 'Old', 'Check', '{}', '{}', 'rule-old', 1, 1, 3, 3)",
        )
        .execute(pool.as_ref())
        .await
        .expect("task definition");
        sqlx::query(
            "INSERT INTO view_definitions (id, name, view_type, scope_query_json, render_spec_json, \
             writeback_policy, stale, version, current_snapshot_id, created_at, updated_at) \
             VALUES ('view-old', 'Old', 'query', '{}', '{}', 'readonly', 0, 1, 'snapshot-old', 3, 3)",
        )
        .execute(pool.as_ref())
        .await
        .expect("view");
        sqlx::query(
            "INSERT INTO view_snapshots (id, view_id, status, source_snapshot_hash, render_json, created_at) \
             VALUES ('snapshot-old', 'view-old', 'fresh', 'hash', '{}', 3)",
        )
        .execute(pool.as_ref())
        .await
        .expect("snapshot");
        sqlx::query(
            "INSERT INTO view_dependencies (snapshot_id, view_id, source_type, knowledge_object_id, source_revision) \
             VALUES ('snapshot-old', 'view-old', 'knowledge_object', 'rule-old', 1)",
        )
        .execute(pool.as_ref())
        .await
        .expect("dependency");

        sqlx::raw_sql(include_str!("../migrations/0014_add_cognitive_core.sql"))
            .execute(pool.as_ref())
            .await
            .expect("cognitive migration");

        let preserved_objects: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_objects WHERE id IN ('rule-old', 'decision-old') \
             AND content = '' AND structured_data_json = '{}'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("objects");
        let preserved_relation: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_object_relations WHERE id = 'relation-old'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("relation");
        let preserved_task_source: String = sqlx::query_scalar(
            "SELECT source_knowledge_object_id FROM task_definitions WHERE id = 'definition-old'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("task source");
        let preserved_dependency: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM view_dependencies WHERE snapshot_id = 'snapshot-old' \
             AND knowledge_object_id = 'rule-old'",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("view dependency");
        let migrated_source: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_object_sources WHERE knowledge_object_id = 'rule-old' \
             AND document_id = 'doc-cognitive' AND revision = 3",
        )
        .fetch_one(pool.as_ref())
        .await
        .expect("legacy source");
        assert_eq!(preserved_objects, 2);
        assert_eq!(preserved_relation, 1);
        assert_eq!(preserved_task_source, "rule-old");
        assert_eq!(preserved_dependency, 1);
        assert_eq!(migrated_source, 1);

        drop(pool);
        close_pool(&path).await.expect("close database");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }
}
