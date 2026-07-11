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
