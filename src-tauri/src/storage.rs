use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use url::Url;

use crate::database::{
    close_pool, configured_data_directory, default_data_directory, DATABASE_FILENAME,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryChange {
    database_path: String,
    backup_path: Option<String>,
    migrated_file_count: usize,
    rewritten_metadata_count: usize,
}

const MANAGED_DATA_ENTRIES: &[&str] = &[
    DATABASE_FILENAME,
    "editor.db-wal",
    "editor.db-shm",
    "assets",
    "skills",
    "mcp-servers.json",
    "mcp-server-exposure.json",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAsset {
    relative_path: String,
    original_name: String,
    mime_type: String,
    size_bytes: u64,
    content_hash: String,
}

#[tauri::command]
pub fn get_system_fonts() -> Vec<String> {
    system_fonts()
}

#[tauri::command]
pub fn get_default_data_directory(app: AppHandle) -> Result<String, String> {
    default_data_directory(&app)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn migrate_data_directory(
    app: AppHandle,
    current_directory: Option<String>,
    destination_directory: Option<String>,
) -> Result<DataDirectoryChange, String> {
    let default_directory = default_data_directory(&app).map_err(|error| error.to_string())?;
    let requested_source_directory = current_directory
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_directory.clone());
    let requested_destination_directory = destination_directory
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_directory);
    fs::create_dir_all(&requested_destination_directory)
        .map_err(|error| format!("无法创建目标目录：{error}"))?;
    let source_directory = fs::canonicalize(&requested_source_directory)
        .map_err(|error| format!("无法解析当前数据目录：{error}"))?;
    let destination_directory = fs::canonicalize(&requested_destination_directory)
        .map_err(|error| format!("无法解析目标数据目录：{error}"))?;
    let source_path = source_directory.join(DATABASE_FILENAME);
    let destination_path = destination_directory.join(DATABASE_FILENAME);

    if source_directory == destination_directory {
        return Ok(DataDirectoryChange {
            database_path: destination_path.to_string_lossy().into_owned(),
            backup_path: None,
            migrated_file_count: 0,
            rewritten_metadata_count: 0,
        });
    }
    if source_directory.starts_with(&destination_directory)
        || destination_directory.starts_with(&source_directory)
    {
        return Err("当前数据目录与目标数据目录不能互相包含。".to_string());
    }
    if !source_path.is_file() {
        return Err(format!("找不到当前数据库：{}", source_path.display()));
    }

    for path in [
        requested_source_directory.join(DATABASE_FILENAME),
        source_path.clone(),
        requested_destination_directory.join(DATABASE_FILENAME),
        destination_path,
    ] {
        close_pool(&path).await?;
    }
    migrate_data_directory_paths(&source_directory, &destination_directory).await
}

async fn migrate_data_directory_paths(
    source_directory: &Path,
    destination_directory: &Path,
) -> Result<DataDirectoryChange, String> {
    let migration_id = unique_timestamp()?;
    let staging_directory =
        destination_directory.join(format!(".my-notebook-migration-{migration_id}"));
    fs::create_dir(&staging_directory).map_err(|error| format!("无法创建迁移暂存目录：{error}"))?;

    let migration_result = async {
        let mut managed_entries = MANAGED_DATA_ENTRIES
            .iter()
            .map(OsString::from)
            .collect::<Vec<_>>();

        // Copy the database and its sidecars first. Reading the staged database then lets us
        // discover locally stored work artifacts without touching the live source database.
        for entry in MANAGED_DATA_ENTRIES.iter().take(3) {
            copy_managed_entry(
                &source_directory.join(entry),
                &staging_directory.join(entry),
            )?;
        }
        let staged_database = staging_directory.join(DATABASE_FILENAME);
        if !staged_database.is_file() {
            return Err(format!(
                "找不到迁移后的暂存数据库：{}",
                staged_database.display()
            ));
        }

        for entry in discover_artifact_entries(&staged_database, source_directory).await? {
            if !managed_entries.contains(&entry) {
                managed_entries.push(entry);
            }
        }

        for entry in managed_entries.iter().skip(3) {
            copy_managed_entry(
                &source_directory.join(entry),
                &staging_directory.join(entry),
            )?;
        }

        let rewritten_metadata_count = rewrite_and_validate_metadata(
            &staged_database,
            source_directory,
            destination_directory,
            &staging_directory,
        )
        .await?;
        let migrated_file_count = count_files_recursive(&staging_directory)?;
        let backup_path = activate_staged_data(
            &staging_directory,
            destination_directory,
            &managed_entries,
            migration_id,
            None,
        )?;

        Ok(DataDirectoryChange {
            database_path: destination_directory
                .join(DATABASE_FILENAME)
                .to_string_lossy()
                .into_owned(),
            backup_path: backup_path.map(|path| path.to_string_lossy().into_owned()),
            migrated_file_count,
            rewritten_metadata_count,
        })
    }
    .await;

    if staging_directory.exists() {
        let cleanup_result = fs::remove_dir_all(&staging_directory);
        if migration_result.is_ok() {
            cleanup_result.map_err(|error| format!("清理迁移暂存目录失败：{error}"))?;
        }
    }
    migration_result
}

async fn discover_artifact_entries(
    database_path: &Path,
    source_directory: &Path,
) -> Result<Vec<OsString>, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(crate::database::database_error)?;
    let result = async {
        if !database_table_exists(&mut connection, "work_artifacts").await? {
            return Ok(Vec::new());
        }
        let rows = sqlx::query("SELECT uri FROM work_artifacts WHERE uri IS NOT NULL")
            .fetch_all(&mut connection)
            .await
            .map_err(crate::database::database_error)?;
        let mut entries = Vec::new();
        for row in rows {
            let uri = row
                .try_get::<String, _>("uri")
                .map_err(crate::database::database_error)?;
            let Some(path) = local_path_from_uri(&uri)? else {
                continue;
            };
            let Some(relative) = path_relative_to_root(&path, source_directory)? else {
                continue;
            };
            let Some(Component::Normal(first)) = relative.components().next() else {
                continue;
            };
            let entry = first.to_os_string();
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }
    .await;
    let close_result = connection
        .close()
        .await
        .map_err(crate::database::database_error);
    match (result, close_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn rewrite_and_validate_metadata(
    database_path: &Path,
    source_directory: &Path,
    destination_directory: &Path,
    staging_directory: &Path,
) -> Result<usize, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(crate::database::database_error)?;
    let result = async {
        let mut rewritten = 0;
        let mut transaction = connection
            .begin()
            .await
            .map_err(crate::database::database_error)?;

        if database_table_exists(&mut *transaction, "assets").await? {
            let rows = sqlx::query("SELECT id, relative_path FROM assets")
                .fetch_all(&mut *transaction)
                .await
                .map_err(crate::database::database_error)?;
            let mut normalized_rows = Vec::with_capacity(rows.len());
            let mut normalized_paths = HashSet::with_capacity(rows.len());
            for row in rows {
                let id = row
                    .try_get::<String, _>("id")
                    .map_err(crate::database::database_error)?;
                let current = row
                    .try_get::<String, _>("relative_path")
                    .map_err(crate::database::database_error)?;
                let normalized = normalize_asset_relative_path(&current, source_directory)?;
                if !normalized_paths.insert(normalized.clone()) {
                    return Err(format!("附件路径规范化后发生重复：{normalized}"));
                }
                validate_staged_asset(staging_directory, &normalized)?;
                normalized_rows.push((id, current, normalized));
            }

            let changed = normalized_rows
                .iter()
                .filter(|(_, current, normalized)| current != normalized)
                .collect::<Vec<_>>();
            for (index, (id, _, _)) in changed.iter().enumerate() {
                sqlx::query("UPDATE assets SET relative_path = ? WHERE id = ?")
                    .bind(format!("assets/.metadata-migration-{index}-{id}"))
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(crate::database::database_error)?;
            }
            for (id, _, normalized) in &changed {
                sqlx::query("UPDATE assets SET relative_path = ? WHERE id = ?")
                    .bind(normalized)
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(crate::database::database_error)?;
            }
            rewritten += changed.len();
        }

        if database_table_exists(&mut *transaction, "work_artifacts").await? {
            let rows = sqlx::query("SELECT id, uri FROM work_artifacts WHERE uri IS NOT NULL")
                .fetch_all(&mut *transaction)
                .await
                .map_err(crate::database::database_error)?;
            for row in rows {
                let id = row
                    .try_get::<String, _>("id")
                    .map_err(crate::database::database_error)?;
                let uri = row
                    .try_get::<String, _>("uri")
                    .map_err(crate::database::database_error)?;
                let Some(rewritten_uri) =
                    rewrite_local_uri(&uri, source_directory, destination_directory)?
                else {
                    continue;
                };
                sqlx::query("UPDATE work_artifacts SET uri = ? WHERE id = ?")
                    .bind(rewritten_uri)
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(crate::database::database_error)?;
                rewritten += 1;
            }
        }

        transaction
            .commit()
            .await
            .map_err(crate::database::database_error)?;
        let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&mut connection)
            .await
            .map_err(crate::database::database_error)?;
        if integrity != "ok" {
            return Err(format!("迁移后的数据库完整性检查失败：{integrity}"));
        }
        let foreign_key_errors = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .map_err(crate::database::database_error)?;
        if !foreign_key_errors.is_empty() {
            return Err(format!(
                "迁移后的数据库存在 {} 条外键错误。",
                foreign_key_errors.len()
            ));
        }
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut connection)
            .await
            .map_err(crate::database::database_error)?;
        Ok(rewritten)
    }
    .await;
    let close_result = connection
        .close()
        .await
        .map_err(crate::database::database_error);
    match (result, close_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn database_table_exists<'e, E>(executor: E, table: &str) -> Result<bool, String>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
    )
    .bind(table)
    .fetch_one(executor)
    .await
    .map(|exists| exists == 1)
    .map_err(crate::database::database_error)
}

fn normalize_asset_relative_path(value: &str, source_directory: &Path) -> Result<String, String> {
    let path = Path::new(value);
    let relative = if path.is_absolute() {
        path_relative_to_root(path, source_directory)?
            .ok_or_else(|| format!("附件绝对路径不在当前数据目录内：{}", path.display()))?
    } else {
        path.to_path_buf()
    };
    let normalized = portable_safe_relative_path(&relative)?;
    if !normalized.starts_with("assets/") {
        return Err(format!("附件路径必须位于 assets 目录：{value}"));
    }
    Ok(normalized)
}

fn validate_staged_asset(staging_directory: &Path, relative_path: &str) -> Result<(), String> {
    let staging_root = fs::canonicalize(staging_directory)
        .map_err(|error| format!("无法校验迁移暂存目录：{error}"))?;
    let asset_path = staging_directory.join(relative_path);
    let canonical_asset = fs::canonicalize(&asset_path)
        .map_err(|error| format!("附件元数据对应的文件不存在（{relative_path}）：{error}"))?;
    if !canonical_asset.starts_with(&staging_root) || !canonical_asset.is_file() {
        return Err(format!("附件路径不安全或不是文件：{relative_path}"));
    }
    Ok(())
}

fn rewrite_local_uri(
    uri: &str,
    source_directory: &Path,
    destination_directory: &Path,
) -> Result<Option<String>, String> {
    let Some(path) = local_path_from_uri(uri)? else {
        return Ok(None);
    };
    let Some(relative) = path_relative_to_root(&path, source_directory)? else {
        return Ok(None);
    };
    let destination = destination_directory.join(relative);
    if uri.trim_start().to_ascii_lowercase().starts_with("file:") {
        return Url::from_file_path(&destination)
            .map(|url| Some(url.to_string()))
            .map_err(|_| format!("无法重写本地文件 URI：{uri}"));
    }
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn local_path_from_uri(uri: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = uri.trim();
    let plain_path = PathBuf::from(trimmed);
    if plain_path.is_absolute() {
        return Ok(Some(plain_path));
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return Ok(None);
    };
    if parsed.scheme() != "file" {
        return Ok(None);
    }
    parsed
        .to_file_path()
        .map(Some)
        .map_err(|_| format!("无效的本地文件 URI：{uri}"))
}

fn path_relative_to_root(path: &Path, root: &Path) -> Result<Option<PathBuf>, String> {
    if !path.is_absolute() {
        return Ok(None);
    }
    let normalized = if path.exists() {
        fs::canonicalize(path).map_err(|error| format!("无法解析本地路径：{error}"))?
    } else {
        normalize_absolute_path(path)?
    };
    let normalized_root =
        fs::canonicalize(root).map_err(|error| format!("无法解析数据目录：{error}"))?;
    Ok(normalized
        .strip_prefix(normalized_root)
        .ok()
        .map(Path::to_path_buf))
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("不是绝对路径：{}", path.display()));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("路径越过文件系统根目录：{}", path.display()));
                }
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn portable_safe_relative_path(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err(format!("路径不是安全的相对路径：{}", path.display())),
        }
    }
    if parts.is_empty() {
        return Err("相对路径不能为空。".to_string());
    }
    Ok(parts.join("/"))
}

fn copy_managed_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("无法读取受管数据 {}：{error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("受管数据不能是符号链接：{}", source.display()));
    }
    if metadata.is_dir() {
        copy_directory_recursive(source, destination)
            .map_err(|error| format!("复制受管目录 {} 失败：{error}", source.display()))
    } else if metadata.is_file() {
        fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| format!("复制受管文件 {} 失败：{error}", source.display()))
    } else {
        Err(format!("不支持的受管数据类型：{}", source.display()))
    }
}

fn activate_staged_data(
    staging_directory: &Path,
    destination_directory: &Path,
    managed_entries: &[OsString],
    migration_id: u128,
    fail_after: Option<usize>,
) -> Result<Option<PathBuf>, String> {
    let backup_directory =
        destination_directory.join(format!(".my-notebook-backup-{migration_id}"));
    let mut backed_up = Vec::new();
    for entry in managed_entries {
        let destination = destination_directory.join(entry);
        if !destination.exists() {
            continue;
        }
        if backed_up.is_empty() {
            fs::create_dir(&backup_directory)
                .map_err(|error| format!("无法创建目标数据备份目录：{error}"))?;
        }
        let backup = backup_directory.join(entry);
        if let Err(error) = fs::rename(&destination, &backup) {
            let rollback_error =
                restore_entries(&backup_directory, destination_directory, &backed_up).err();
            return Err(with_rollback_error(
                format!("备份目标数据 {} 失败：{error}", destination.display()),
                rollback_error,
            ));
        }
        backed_up.push(entry.clone());
    }

    let mut activated: Vec<OsString> = Vec::new();
    for entry in managed_entries {
        let staged = staging_directory.join(entry);
        if !staged.exists() {
            continue;
        }
        let activation_result = if fail_after == Some(activated.len()) {
            Err(std::io::Error::other("injected activation failure"))
        } else {
            fs::rename(&staged, destination_directory.join(entry))
        };
        if let Err(error) = activation_result {
            let mut rollback_errors = Vec::new();
            for activated_entry in activated.iter().rev() {
                if let Err(rollback_error) =
                    remove_path(&destination_directory.join(activated_entry))
                {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            if let Err(rollback_error) =
                restore_entries(&backup_directory, destination_directory, &backed_up)
            {
                rollback_errors.push(rollback_error);
            }
            return Err(with_rollback_error(
                format!("启用迁移数据 {} 失败：{error}", staged.display()),
                (!rollback_errors.is_empty()).then(|| rollback_errors.join("；")),
            ));
        }
        activated.push(entry.clone());
    }

    Ok((!backed_up.is_empty()).then_some(backup_directory))
}

fn restore_entries(
    backup_directory: &Path,
    destination_directory: &Path,
    entries: &[OsString],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for entry in entries.iter().rev() {
        let backup = backup_directory.join(entry);
        if backup.exists() {
            if let Err(error) = fs::rename(&backup, destination_directory.join(entry)) {
                errors.push(format!("恢复 {} 失败：{error}", backup.display()));
            }
        }
    }
    if errors.is_empty() {
        if backup_directory.is_dir() {
            let _ = fs::remove_dir(backup_directory);
        }
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

fn with_rollback_error(error: String, rollback_error: Option<String>) -> String {
    match rollback_error {
        Some(rollback) => format!("{error}；回滚未完全成功：{rollback}"),
        None => error,
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else if path.exists() {
        fs::remove_file(path)
    } else {
        Ok(())
    }
}

fn count_files_recursive(path: &Path) -> Result<usize, String> {
    let mut count = 0;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            count += count_files_recursive(&entry.path())?;
        } else if metadata.is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn unique_timestamp() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn store_asset_data_url(
    app: AppHandle,
    data_directory: Option<String>,
    asset_id: String,
    data_url: String,
    original_name: String,
) -> Result<StoredAsset, String> {
    let data_directory =
        configured_data_directory(&app, data_directory).map_err(|error| error.to_string())?;
    let assets_directory = data_directory.join("assets");
    fs::create_dir_all(&assets_directory).map_err(|error| format!("无法创建附件目录：{error}"))?;
    let (mime_type, bytes) = decode_data_url(&data_url)?;
    let extension = extension_for_asset(&original_name, &mime_type);
    let safe_asset_id = sanitize_path_segment(&asset_id);
    let filename = if extension.is_empty() {
        safe_asset_id
    } else {
        format!("{safe_asset_id}.{extension}")
    };
    fs::write(assets_directory.join(&filename), &bytes)
        .map_err(|error| format!("写入附件失败：{error}"))?;
    Ok(StoredAsset {
        relative_path: format!("assets/{filename}"),
        original_name: original_name.trim().to_string(),
        mime_type,
        size_bytes: bytes.len() as u64,
        content_hash: content_hash(&bytes),
    })
}

#[tauri::command]
pub fn get_asset_data_url(
    app: AppHandle,
    data_directory: Option<String>,
    relative_path: String,
    mime_type: String,
) -> Result<String, String> {
    let path = resolve_relative_asset_path(&app, data_directory, &relative_path)?;
    let bytes = fs::read(&path).map_err(|error| format!("读取附件失败：{error}"))?;
    Ok(format!(
        "data:{};base64,{}",
        if mime_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            mime_type.trim()
        },
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn resolve_asset_path(
    app: AppHandle,
    data_directory: Option<String>,
    relative_path: String,
) -> Result<String, String> {
    resolve_relative_asset_path(&app, data_directory, &relative_path)
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn remove_asset_file(
    app: AppHandle,
    data_directory: Option<String>,
    relative_path: String,
) -> Result<(), String> {
    let path = resolve_relative_asset_path(&app, data_directory, &relative_path)?;
    if path.is_file() {
        fs::remove_file(path).map_err(|error| format!("删除附件文件失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建导出目录：{error}"))?;
    }
    fs::write(&path, content).map_err(|error| format!("导出文件失败：{error}"))
}

fn resolve_relative_asset_path(
    app: &AppHandle,
    data_directory: Option<String>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = PathBuf::from(relative_path);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("附件路径不安全。".to_string());
    }
    if !matches!(
        relative.components().next(),
        Some(Component::Normal(value)) if value == "assets"
    ) {
        return Err("附件路径必须位于 assets 目录。".to_string());
    }
    let base = configured_data_directory(app, data_directory).map_err(|error| error.to_string())?;
    Ok(base.join(relative))
}

fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "附件内容不是有效的 data URL。".to_string())?;
    if !header.starts_with("data:") || !header.contains(";base64") {
        return Err("附件内容必须是 base64 data URL。".to_string());
    }
    let mime_type = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    general_purpose::STANDARD
        .decode(payload)
        .map(|bytes| (mime_type, bytes))
        .map_err(|error| format!("附件 base64 解码失败：{error}"))
}

fn extension_for_asset(original_name: &str, mime_type: &str) -> String {
    if let Some(extension) = PathBuf::from(original_name)
        .extension()
        .and_then(|value| value.to_str())
    {
        return sanitize_path_segment(extension).to_lowercase();
    }
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        _ => "",
    }
    .to_string()
}

fn sanitize_path_segment(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-').trim_matches('.');
    if trimmed.is_empty() {
        "asset".to_string()
    } else {
        trimmed.to_string()
    }
}

fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "symbolic links are not supported: {}",
                    source_path.display()
                ),
            ));
        }
        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unsupported file type: {}", source_path.display()),
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn system_fonts() -> Vec<String> {
    use std::collections::BTreeSet;
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(fonts_key) = hklm.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts")
    else {
        return fallback_fonts();
    };
    let fonts: Vec<String> = fonts_key
        .enum_values()
        .flatten()
        .filter_map(|item| normalize_windows_font_name(&item.0))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if fonts.is_empty() {
        fallback_fonts()
    } else {
        fonts
    }
}

#[cfg(not(target_os = "windows"))]
fn system_fonts() -> Vec<String> {
    fallback_fonts()
}

fn fallback_fonts() -> Vec<String> {
    [
        "Arial",
        "Helvetica Neue",
        "Inter",
        "Microsoft YaHei",
        "Noto Sans CJK SC",
        "PingFang SC",
        "Segoe UI",
        "SimHei",
        "SimSun",
        "Source Han Sans SC",
    ]
    .iter()
    .map(|font| font.to_string())
    .collect()
}

#[cfg(target_os = "windows")]
fn normalize_windows_font_name(value: &str) -> Option<String> {
    let without_suffix = value
        .replace("(TrueType)", "")
        .replace("(OpenType)", "")
        .replace('&', ",");
    let normalized = without_suffix
        .split(',')
        .next()?
        .split_whitespace()
        .filter(|part| {
            !matches!(
                part.to_ascii_lowercase().as_str(),
                "regular" | "bold" | "italic" | "light" | "medium" | "semibold" | "black"
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "my-notebook-storage-{name}-{}-{}",
            std::process::id(),
            unique_timestamp().expect("timestamp")
        ))
    }

    fn cleanup_test_directory(path: &Path) {
        let mut last_error = None;
        // Windows may keep a just-closed SQLite/WAL handle alive briefly while the
        // async driver and virus scanner release it. Keep cleanup bounded, but give
        // those handles enough time to drain when the full test suite runs in parallel.
        for _ in 0..100 {
            match fs::remove_dir_all(path) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => last_error = Some(error),
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!(
            "cleanup failed after bounded Windows file-lock retries: {}",
            last_error.expect("cleanup error")
        );
    }

    #[tokio::test]
    async fn migrates_managed_files_and_rewrites_local_metadata() {
        let root = test_directory("complete");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("assets")).expect("source assets");
        fs::create_dir_all(source.join("skills/demo")).expect("source skills");
        fs::create_dir_all(source.join("deliveries")).expect("source deliveries");
        fs::create_dir_all(destination.join("assets")).expect("destination assets");
        fs::write(source.join("assets/photo.png"), b"image").expect("asset");
        fs::write(source.join("skills/demo/SKILL.md"), b"skill").expect("skill");
        fs::write(source.join("mcp-servers.json"), b"{\"mcpServers\":{}}").expect("mcp config");
        fs::write(source.join("deliveries/report.txt"), b"report").expect("artifact");
        fs::write(destination.join(DATABASE_FILENAME), b"old database").expect("old database");
        fs::write(destination.join("assets/old.txt"), b"old asset").expect("old asset");

        let source_database = source.join(DATABASE_FILENAME);
        let pool = crate::database::get_pool_for_path(&source_database, true)
            .await
            .expect("source database");
        sqlx::query(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE)",
        )
        .execute(pool.as_ref())
        .await
        .expect("assets table");
        sqlx::query("CREATE TABLE work_artifacts (id TEXT PRIMARY KEY, uri TEXT)")
            .execute(pool.as_ref())
            .await
            .expect("artifacts table");
        sqlx::query("INSERT INTO assets (id, relative_path) VALUES ('asset-1', ?)")
            .bind(source.join("assets/photo.png").to_string_lossy().as_ref())
            .execute(pool.as_ref())
            .await
            .expect("asset metadata");
        sqlx::query(
            "INSERT INTO work_artifacts (id, uri) VALUES ('local', ?), ('external', 'https://example.com/report')",
        )
        .bind(source.join("deliveries/report.txt").to_string_lossy().as_ref())
        .execute(pool.as_ref())
        .await
        .expect("artifact metadata");
        drop(pool);
        crate::database::close_pool(&source_database)
            .await
            .expect("close source");

        let source = fs::canonicalize(source).expect("canonical source");
        let destination = fs::canonicalize(destination).expect("canonical destination");
        let change = migrate_data_directory_paths(&source, &destination)
            .await
            .expect("migration");

        assert!(change.migrated_file_count >= 5);
        assert_eq!(change.rewritten_metadata_count, 2);
        assert_eq!(
            fs::read(destination.join("assets/photo.png")).unwrap(),
            b"image"
        );
        assert_eq!(
            fs::read(destination.join("skills/demo/SKILL.md")).unwrap(),
            b"skill"
        );
        assert!(destination.join("mcp-servers.json").is_file());
        assert_eq!(
            fs::read(destination.join("deliveries/report.txt")).unwrap(),
            b"report"
        );

        let destination_database = destination.join(DATABASE_FILENAME);
        let migrated_pool = crate::database::get_pool_for_path(&destination_database, false)
            .await
            .expect("migrated database");
        let asset_path: String =
            sqlx::query_scalar("SELECT relative_path FROM assets WHERE id = 'asset-1'")
                .fetch_one(migrated_pool.as_ref())
                .await
                .expect("asset path");
        assert_eq!(asset_path, "assets/photo.png");
        let local_uri: String =
            sqlx::query_scalar("SELECT uri FROM work_artifacts WHERE id = 'local'")
                .fetch_one(migrated_pool.as_ref())
                .await
                .expect("local uri");
        assert_eq!(
            local_uri,
            destination.join("deliveries/report.txt").to_string_lossy()
        );
        let external_uri: String =
            sqlx::query_scalar("SELECT uri FROM work_artifacts WHERE id = 'external'")
                .fetch_one(migrated_pool.as_ref())
                .await
                .expect("external uri");
        assert_eq!(external_uri, "https://example.com/report");
        drop(migrated_pool);
        crate::database::close_pool(&destination_database)
            .await
            .expect("close destination");

        let backup = PathBuf::from(change.backup_path.expect("backup path"));
        assert_eq!(
            fs::read(backup.join(DATABASE_FILENAME)).unwrap(),
            b"old database"
        );
        assert_eq!(
            fs::read(backup.join("assets/old.txt")).unwrap(),
            b"old asset"
        );
        cleanup_test_directory(&root);
    }

    #[test]
    fn activation_failure_restores_all_target_entries() {
        let root = test_directory("rollback");
        let staging = root.join("staging");
        let destination = root.join("destination");
        fs::create_dir_all(staging.join("assets")).expect("staging assets");
        fs::create_dir_all(destination.join("assets")).expect("destination assets");
        fs::write(staging.join(DATABASE_FILENAME), b"new database").expect("new database");
        fs::write(staging.join("assets/new.txt"), b"new asset").expect("new asset");
        fs::write(destination.join(DATABASE_FILENAME), b"old database").expect("old database");
        fs::write(destination.join("assets/old.txt"), b"old asset").expect("old asset");
        fs::write(destination.join("mcp-servers.json"), b"old config").expect("old config");

        let entries = MANAGED_DATA_ENTRIES
            .iter()
            .map(OsString::from)
            .collect::<Vec<_>>();
        let result = activate_staged_data(
            &staging,
            &destination,
            &entries,
            unique_timestamp().expect("timestamp"),
            Some(1),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(destination.join(DATABASE_FILENAME)).unwrap(),
            b"old database"
        );
        assert_eq!(
            fs::read(destination.join("assets/old.txt")).unwrap(),
            b"old asset"
        );
        assert!(!destination.join("assets/new.txt").exists());
        assert_eq!(
            fs::read(destination.join("mcp-servers.json")).unwrap(),
            b"old config"
        );
        cleanup_test_directory(&root);
    }

    #[test]
    fn only_rewrites_local_uris_inside_the_old_data_directory() {
        let root = test_directory("uris");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("assets")).expect("source");
        fs::create_dir_all(&destination).expect("destination");
        let file = source.join("assets/a b.txt");
        fs::write(&file, b"asset").expect("file");
        let file_uri = Url::from_file_path(&file).expect("file uri").to_string();

        let rewritten = rewrite_local_uri(&file_uri, &source, &destination)
            .expect("rewrite")
            .expect("local rewrite");
        assert_eq!(
            Url::parse(&rewritten).unwrap().to_file_path().unwrap(),
            destination.join("assets/a b.txt")
        );
        assert!(
            rewrite_local_uri("https://example.com/a", &source, &destination)
                .expect("external")
                .is_none()
        );
        assert!(rewrite_local_uri(
            &root.join("outside.txt").to_string_lossy(),
            &source,
            &destination,
        )
        .expect("outside")
        .is_none());
        cleanup_test_directory(&root);
    }
}
