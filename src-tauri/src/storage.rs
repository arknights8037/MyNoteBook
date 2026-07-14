use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

use crate::database::{
    close_pool, configured_data_directory, default_data_directory, DATABASE_FILENAME,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryChange {
    database_path: String,
    backup_path: Option<String>,
}

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
    let source_directory = current_directory
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_directory.clone());
    let destination_directory = destination_directory
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_directory);
    let source_path = source_directory.join(DATABASE_FILENAME);
    let destination_path = destination_directory.join(DATABASE_FILENAME);

    if source_path == destination_path {
        return Ok(DataDirectoryChange {
            database_path: destination_path.to_string_lossy().into_owned(),
            backup_path: None,
        });
    }
    if !source_path.is_file() {
        return Err(format!("找不到当前数据库：{}", source_path.display()));
    }
    close_pool(&source_path).await?;
    close_pool(&destination_path).await?;
    fs::create_dir_all(&destination_directory)
        .map_err(|error| format!("无法创建目标目录：{error}"))?;

    let temporary_path = destination_directory.join("editor.db.migrating");
    if temporary_path.exists() {
        fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
    }
    fs::copy(&source_path, &temporary_path).map_err(|error| format!("复制数据库失败：{error}"))?;
    let source_assets_directory = source_directory.join("assets");
    let temporary_assets_directory = destination_directory.join("assets.migrating");
    if temporary_assets_directory.exists() {
        fs::remove_dir_all(&temporary_assets_directory)
            .map_err(|error| format!("清理临时附件目录失败：{error}"))?;
    }
    if source_assets_directory.is_dir() {
        copy_directory_recursive(&source_assets_directory, &temporary_assets_directory)
            .map_err(|error| format!("复制附件失败：{error}"))?;
    }
    let source_skills_directory = source_directory.join("skills");
    let temporary_skills_directory = destination_directory.join("skills.migrating");
    if temporary_skills_directory.exists() {
        fs::remove_dir_all(&temporary_skills_directory)
            .map_err(|error| format!("清理临时技能目录失败：{error}"))?;
    }
    if source_skills_directory.is_dir() {
        copy_directory_recursive(&source_skills_directory, &temporary_skills_directory)
            .map_err(|error| format!("复制技能失败：{error}"))?;
    }

    let backup_path = if destination_path.exists() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs();
        let backup = destination_directory.join(format!("editor-backup-{timestamp}.db"));
        fs::rename(&destination_path, &backup)
            .map_err(|error| format!("备份目标数据库失败：{error}"))?;
        Some(backup)
    } else {
        None
    };

    if let Err(error) = fs::rename(&temporary_path, &destination_path) {
        if let Some(backup) = &backup_path {
            let _ = fs::rename(backup, &destination_path);
        }
        return Err(format!("启用新数据库失败：{error}"));
    }
    copy_database_sidecar(&source_path, &destination_path, "-wal")
        .map_err(|error| format!("复制数据库 WAL 日志失败：{error}"))?;
    copy_database_sidecar(&source_path, &destination_path, "-shm")
        .map_err(|error| format!("复制数据库共享内存文件失败：{error}"))?;
    let destination_assets_directory = destination_directory.join("assets");
    if temporary_assets_directory.is_dir() {
        if destination_assets_directory.exists() {
            fs::remove_dir_all(&destination_assets_directory)
                .map_err(|error| format!("替换附件目录失败：{error}"))?;
        }
        fs::rename(&temporary_assets_directory, &destination_assets_directory)
            .map_err(|error| format!("启用新附件目录失败：{error}"))?;
    }
    let destination_skills_directory = destination_directory.join("skills");
    if temporary_skills_directory.is_dir() {
        if destination_skills_directory.exists() {
            fs::remove_dir_all(&destination_skills_directory)
                .map_err(|error| format!("替换技能目录失败：{error}"))?;
        }
        fs::rename(&temporary_skills_directory, &destination_skills_directory)
            .map_err(|error| format!("启用新技能目录失败：{error}"))?;
    }

    Ok(DataDirectoryChange {
        database_path: destination_path.to_string_lossy().into_owned(),
        backup_path: backup_path.map(|path| path.to_string_lossy().into_owned()),
    })
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
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn copy_database_sidecar(
    source_database: &Path,
    destination_database: &Path,
    suffix: &str,
) -> std::io::Result<()> {
    let source = PathBuf::from(format!("{}{}", source_database.display(), suffix));
    let destination = PathBuf::from(format!("{}{}", destination_database.display(), suffix));
    if source.is_file() {
        fs::copy(source, destination)?;
    } else if destination.exists() {
        fs::remove_file(destination)?;
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
        .trim()
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
