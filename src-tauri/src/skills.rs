use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::AppHandle;

use crate::database::configured_data_directory;

const SKILL_FILE_NAME: &str = "SKILL.md";
const STATE_FILE_NAME: &str = ".skill-state.json";
const MAX_TEXT_FILE_BYTES: u64 = 1_048_576;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    id: String,
    name: String,
    description: String,
    version: Option<String>,
    path: String,
    enabled: bool,
    valid: bool,
    validation_error: Option<String>,
    modified_at: u64,
    files: Vec<SkillFileEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    path: String,
    name: String,
    kind: &'static str,
    size_bytes: u64,
    editable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDataDirectoryInput {
    data_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillInput {
    data_directory: Option<String>,
    source_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillInput {
    data_directory: Option<String>,
    name: String,
    description: String,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStateInput {
    data_directory: Option<String>,
    skill_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileInput {
    data_directory: Option<String>,
    skill_id: String,
    relative_path: String,
    require_enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillFileInput {
    data_directory: Option<String>,
    skill_id: String,
    relative_path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSkillInput {
    data_directory: Option<String>,
    skill_id: String,
}

#[tauri::command]
pub fn list_installed_skills(
    app: AppHandle,
    input: SkillDataDirectoryInput,
) -> Result<Vec<InstalledSkill>, String> {
    let root = skills_root(&app, input.data_directory)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建技能目录：{error}"))?;
    let disabled = read_disabled_skills(&root);
    let mut skills = fs::read_dir(&root)
        .map_err(|error| format!("无法读取技能目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| inspect_skill(&entry.path(), &disabled).ok())
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(skills)
}

#[tauri::command]
pub fn import_skill_directory(
    app: AppHandle,
    input: ImportSkillInput,
) -> Result<Vec<InstalledSkill>, String> {
    let source = PathBuf::from(input.source_path.trim());
    if !source.is_dir() {
        return Err("请选择包含 SKILL.md 的技能目录。".to_string());
    }
    let root = skills_root(&app, input.data_directory)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建技能目录：{error}"))?;
    let sources = discover_import_sources(&source)?;
    let disabled = read_disabled_skills(&root);
    let mut imported = Vec::new();
    for skill_source in sources {
        let base_id = sanitize_skill_id(
            skill_source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill"),
        );
        let destination = available_destination(&root, &base_id);
        copy_directory_recursive(&skill_source, &destination)?;
        imported.push(inspect_skill(&destination, &disabled)?);
    }
    Ok(imported)
}

#[tauri::command]
pub fn create_skill(app: AppHandle, input: CreateSkillInput) -> Result<InstalledSkill, String> {
    let name = input.name.trim();
    let description = input.description.trim();
    if name.is_empty() || description.is_empty() {
        return Err("技能名称和描述不能为空。".to_string());
    }
    let root = skills_root(&app, input.data_directory)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建技能目录：{error}"))?;
    let destination = available_destination(&root, &sanitize_skill_id(name));
    fs::create_dir_all(&destination).map_err(|error| format!("无法创建技能：{error}"))?;
    let content = format!(
        "---\nname: {}\ndescription: {}\n---\n\n# {}\n\n在此描述触发条件、工作流程和边界。\n\n## 可选目录\n\n- `scripts/`：可复用脚本\n- `references/`：按需读取的参考资料\n- `assets/`：模板与静态资源\n",
        yaml_scalar(name),
        yaml_scalar(description),
        name
    );
    fs::write(destination.join(SKILL_FILE_NAME), content)
        .map_err(|error| format!("无法写入 SKILL.md：{error}"))?;
    let mut disabled = read_disabled_skills(&root);
    if input.enabled == Some(false) {
        let skill_id = destination
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "无法确定新建技能 ID。".to_string())?;
        disabled.insert(skill_id.to_string());
        write_disabled_skills(&root, &disabled)?;
    }
    inspect_skill(&destination, &disabled)
}

#[tauri::command]
pub fn set_skill_enabled(app: AppHandle, input: SkillStateInput) -> Result<(), String> {
    let root = skills_root(&app, input.data_directory)?;
    let skill_directory = resolve_skill_directory(&root, &input.skill_id)?;
    if !skill_directory.is_dir() {
        return Err("技能不存在。".to_string());
    }
    let mut disabled = read_disabled_skills(&root);
    if input.enabled {
        disabled.remove(&input.skill_id);
    } else {
        disabled.insert(input.skill_id);
    }
    write_disabled_skills(&root, &disabled)
}

#[tauri::command]
pub fn read_skill_file(app: AppHandle, input: SkillFileInput) -> Result<String, String> {
    let root = skills_root(&app, input.data_directory)?;
    if input.require_enabled.unwrap_or(false) {
        if read_disabled_skills(&root).contains(&input.skill_id) {
            return Err("该技能未启用。".to_string());
        }
        let skill = inspect_skill(
            &resolve_skill_directory(&root, &input.skill_id)?,
            &BTreeSet::new(),
        )?;
        if !skill.valid {
            return Err("该技能的 SKILL.md 无效。".to_string());
        }
    }
    let path = resolve_skill_file(&root, &input.skill_id, &input.relative_path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取技能文件：{error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_FILE_BYTES || !is_text_file(&path) {
        return Err("该文件不是可读取的文本文件，或大小超过 1 MB。".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("无法按 UTF-8 读取技能文件：{error}"))
}

#[tauri::command]
pub fn write_skill_file(app: AppHandle, input: WriteSkillFileInput) -> Result<(), String> {
    if input.content.len() > MAX_TEXT_FILE_BYTES as usize {
        return Err("技能文件内容不得超过 1 MB。".to_string());
    }
    let root = skills_root(&app, input.data_directory)?;
    let path = resolve_skill_file(&root, &input.skill_id, &input.relative_path)?;
    if !path.is_file() || !is_text_file(&path) {
        return Err("只能编辑技能目录中已有的文本文件。".to_string());
    }
    fs::write(path, input.content).map_err(|error| format!("保存技能文件失败：{error}"))
}

#[tauri::command]
pub fn remove_installed_skill(app: AppHandle, input: RemoveSkillInput) -> Result<(), String> {
    let root = skills_root(&app, input.data_directory)?;
    let path = resolve_skill_directory(&root, &input.skill_id)?;
    if !path.is_dir() {
        return Err("技能不存在。".to_string());
    }
    fs::remove_dir_all(path).map_err(|error| format!("移除技能失败：{error}"))?;
    let mut disabled = read_disabled_skills(&root);
    disabled.remove(&input.skill_id);
    write_disabled_skills(&root, &disabled)
}

#[tauri::command]
pub fn get_skills_directory(
    app: AppHandle,
    input: SkillDataDirectoryInput,
) -> Result<String, String> {
    let root = skills_root(&app, input.data_directory)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建技能目录：{error}"))?;
    Ok(root.to_string_lossy().into_owned())
}

fn skills_root(app: &AppHandle, data_directory: Option<String>) -> Result<PathBuf, String> {
    configured_data_directory(app, data_directory)
        .map(|directory| directory.join("skills"))
        .map_err(|error| error.to_string())
}

fn inspect_skill(path: &Path, disabled: &BTreeSet<String>) -> Result<InstalledSkill, String> {
    let id = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "技能目录名称不是有效的 UTF-8。".to_string())?
        .to_string();
    let skill_file = find_skill_file(path);
    let (frontmatter, validation_error) = match &skill_file {
        Some(file) => match fs::read_to_string(file) {
            Ok(content) => {
                let parsed = parse_frontmatter(&content);
                let error = if parsed.name.is_none() || parsed.description.is_none() {
                    Some("SKILL.md frontmatter 需要 name 和 description。".to_string())
                } else {
                    None
                };
                (parsed, error)
            }
            Err(error) => (
                Frontmatter::default(),
                Some(format!("无法读取 SKILL.md：{error}")),
            ),
        },
        None => (
            Frontmatter::default(),
            Some("目录中缺少 SKILL.md。".to_string()),
        ),
    };
    let files = collect_files(path)?;
    let modified_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    Ok(InstalledSkill {
        name: frontmatter.name.unwrap_or_else(|| id.clone()),
        description: frontmatter
            .description
            .unwrap_or_else(|| "这个目录尚未提供有效的技能描述。".to_string()),
        version: frontmatter.version,
        path: path.to_string_lossy().into_owned(),
        enabled: !disabled.contains(&id) && validation_error.is_none(),
        valid: validation_error.is_none(),
        validation_error,
        modified_at,
        files,
        id,
    })
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    version: Option<String>,
}

fn parse_frontmatter(content: &str) -> Frontmatter {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines = normalized.lines().collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return Frontmatter::default();
    }
    let mut result = Frontmatter::default();
    let mut index = 1;
    while let Some(line) = lines.get(index) {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        let raw_value = value.trim();
        let value = if matches!(raw_value, ">" | "|") {
            let separator = if raw_value == ">" { " " } else { "\n" };
            let mut parts = Vec::new();
            index += 1;
            while let Some(continuation) = lines.get(index) {
                if continuation.trim() == "---"
                    || (!continuation.trim().is_empty()
                        && !continuation.starts_with(' ')
                        && !continuation.starts_with('\t'))
                {
                    index = index.saturating_sub(1);
                    break;
                }
                if !continuation.trim().is_empty() {
                    parts.push(continuation.trim());
                }
                index += 1;
            }
            parts.join(separator)
        } else {
            unquote_yaml_scalar(raw_value)
        };
        match key {
            "name" if !value.is_empty() => result.name = Some(value),
            "description" if !value.is_empty() => result.description = Some(value),
            "version" if !value.is_empty() => result.version = Some(value),
            _ => {}
        }
        index += 1;
    }
    result
}

fn collect_files(root: &Path) -> Result<Vec<SkillFileEntry>, String> {
    fn visit(
        root: &Path,
        directory: &Path,
        output: &mut Vec<SkillFileEntry>,
    ) -> Result<(), String> {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("无法读取技能文件：{error}"))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file_type = entry
                .file_type()
                .map_err(|error| format!("无法读取技能文件类型：{error}"))?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if file_type.is_dir() {
                output.push(SkillFileEntry {
                    path: relative.clone(),
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind: "directory",
                    size_bytes: 0,
                    editable: false,
                });
                visit(root, &path, output)?;
            } else if file_type.is_file() {
                let size = entry
                    .metadata()
                    .map(|value| value.len())
                    .unwrap_or_default();
                output.push(SkillFileEntry {
                    path: relative,
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind: "file",
                    size_bytes: size,
                    editable: size <= MAX_TEXT_FILE_BYTES && is_text_file(&path),
                });
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn discover_import_sources(source: &Path) -> Result<Vec<PathBuf>, String> {
    if find_skill_file(source).is_some() {
        return Ok(vec![source.to_path_buf()]);
    }
    let skills = fs::read_dir(source)
        .map_err(|error| format!("无法读取所选目录：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && find_skill_file(path).is_some())
        .collect::<Vec<_>>();
    if skills.is_empty() {
        Err("所选目录及其一级子目录中均未找到 SKILL.md。".to_string())
    } else {
        Ok(skills)
    }
}

fn find_skill_file(directory: &Path) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .find_map(|entry| {
            let name = entry.file_name();
            (entry.path().is_file() && name.to_string_lossy().eq_ignore_ascii_case(SKILL_FILE_NAME))
                .then(|| entry.path())
        })
}

fn resolve_skill_directory(root: &Path, skill_id: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(skill_id).components();
    let is_single_normal_segment =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if skill_id.is_empty() || !is_single_normal_segment || skill_id.contains(['/', '\\']) {
        return Err("技能 ID 不安全。".to_string());
    }
    Ok(root.join(skill_id))
}

fn resolve_skill_file(root: &Path, skill_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    let directory = resolve_skill_directory(root, skill_id)?;
    let relative = Path::new(relative_path);
    if !is_safe_relative_path(relative) {
        return Err("技能文件路径不安全。".to_string());
    }
    let canonical_directory =
        fs::canonicalize(&directory).map_err(|error| format!("无法定位技能目录：{error}"))?;
    let canonical_path = fs::canonicalize(directory.join(relative))
        .map_err(|error| format!("无法定位技能文件：{error}"))?;
    if !canonical_path.starts_with(&canonical_directory) {
        return Err("技能文件路径越出了技能目录。".to_string());
    }
    Ok(canonical_path)
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn available_destination(root: &Path, base_id: &str) -> PathBuf {
    let initial = root.join(base_id);
    if !initial.exists() {
        return initial;
    }
    (2..10_000)
        .map(|suffix| root.join(format!("{base_id}-{suffix}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| root.join(format!("{base_id}-copy")))
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("无法创建技能目录：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取源技能目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取源技能文件：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取源技能类型：{error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|error| format!("复制技能文件失败：{error}"))?;
        }
    }
    Ok(())
}

fn read_disabled_skills(root: &Path) -> BTreeSet<String> {
    fs::read_to_string(root.join(STATE_FILE_NAME))
        .ok()
        .and_then(|content| serde_json::from_str::<Vec<String>>(&content).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn write_disabled_skills(root: &Path, disabled: &BTreeSet<String>) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建技能目录：{error}"))?;
    let content = serde_json::to_string_pretty(&disabled.iter().collect::<Vec<_>>())
        .map_err(|error| error.to_string())?;
    fs::write(root.join(STATE_FILE_NAME), content)
        .map_err(|error| format!("无法保存技能启用状态：{error}"))
}

fn sanitize_skill_id(value: &str) -> String {
    let value = value.trim().to_lowercase();
    let mut result = String::new();
    let mut separator = false;
    for character in value.chars() {
        if character.is_alphanumeric() || character == '_' {
            result.push(character);
            separator = false;
        } else if !separator && !result.is_empty() {
            result.push('-');
            separator = true;
        }
    }
    let result = result.trim_matches('-');
    if result.is_empty() {
        "skill".to_string()
    } else {
        result.chars().take(80).collect()
    }
}

fn is_text_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "mdx"
            | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "csv"
            | "tsv"
            | "js"
            | "mjs"
            | "cjs"
            | "ts"
            | "tsx"
            | "jsx"
            | "py"
            | "rs"
            | "sh"
            | "ps1"
            | "css"
            | "html"
            | "xml"
            | "svg"
            | "sql"
    )
}

fn yaml_scalar(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn unquote_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_skill_frontmatter() {
        let parsed = parse_frontmatter(
            "---\nname: document-review\ndescription: \"Review a document\"\nversion: 1.2.0\n---\n# Instructions",
        );
        assert_eq!(parsed.name.as_deref(), Some("document-review"));
        assert_eq!(parsed.description.as_deref(), Some("Review a document"));
        assert_eq!(parsed.version.as_deref(), Some("1.2.0"));
    }

    #[test]
    fn parses_folded_yaml_descriptions() {
        let parsed = parse_frontmatter(
            "---\nname: document-review\ndescription: >\n  Review long documents\n  and summarize findings.\n---\n",
        );
        assert_eq!(
            parsed.description.as_deref(),
            Some("Review long documents and summarize findings.")
        );
    }

    #[test]
    fn inspects_skill_md_and_nested_folders() {
        let root = std::env::temp_dir().join(format!(
            "my-notebook-skill-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("references")).expect("create test skill");
        fs::write(
            root.join(SKILL_FILE_NAME),
            "---\nname: test-skill\ndescription: Test nested files\n---\n",
        )
        .expect("write SKILL.md");
        fs::write(root.join("references/guide.md"), "# Guide").expect("write reference");

        let skill = inspect_skill(&root, &BTreeSet::new()).expect("inspect skill");
        assert!(skill.valid);
        assert_eq!(skill.name, "test-skill");
        assert!(skill.files.iter().any(|file| file.path == "SKILL.md"));
        assert!(skill
            .files
            .iter()
            .any(|file| file.path == "references/guide.md"));
        fs::remove_dir_all(root).expect("remove test skill");
    }

    #[test]
    fn rejects_paths_that_escape_a_skill() {
        let root = Path::new("skills");
        assert!(is_safe_relative_path(Path::new("references/guide.md")));
        assert!(!is_safe_relative_path(Path::new("../secret.txt")));
        assert!(resolve_skill_directory(root, "demo/other").is_err());
        assert!(resolve_skill_directory(root, ".").is_err());
        assert!(resolve_skill_directory(root, "..").is_err());
    }
}
