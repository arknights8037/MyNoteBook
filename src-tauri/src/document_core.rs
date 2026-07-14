use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, Sqlite, Transaction};
use tauri::AppHandle;

use crate::database::{database_error, open_database};

#[derive(Debug, Clone)]
pub struct ProjectedBlock {
    pub id: String,
    pub block_type: String,
    pub block_index: i64,
    pub content_json: String,
    pub plain_text: String,
}

#[derive(Debug, Clone)]
pub struct ProjectedDocument {
    pub content_json: String,
    pub plain_text: String,
    pub blocks: Vec<ProjectedBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistDocumentInput {
    pub data_directory: Option<String>,
    pub id: String,
    pub expected_revision: Option<i64>,
    pub parent_id: Option<String>,
    pub document_kind: String,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    pub content_json: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub is_deleted: bool,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistDocumentResult {
    pub id: String,
    pub revision: i64,
    pub plain_text: String,
    pub content_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildDocumentProjectionsInput {
    pub data_directory: Option<String>,
    pub document_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildDocumentProjectionsResult {
    pub scanned: usize,
    pub repaired: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn persist_document(
    app: AppHandle,
    input: PersistDocumentInput,
) -> Result<PersistDocumentResult, String> {
    if input.id.trim().is_empty() {
        return Err("文档 ID 不能为空。".to_string());
    }
    if input.document_kind != "article" && input.document_kind != "group" {
        return Err("documentKind 必须是 article 或 group。".to_string());
    }
    let projection = validate_and_project_tiptap(
        &input.content_json,
        input.document_kind == "article" && !input.is_deleted,
    )?;
    let pool = open_database(&app, input.data_directory).await?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let current = sqlx::query("SELECT revision, created_at FROM documents WHERE id = ? LIMIT 1")
        .bind(&input.id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?;
    let revision = if let Some(row) = current {
        let actual_revision: i64 = row.try_get("revision").map_err(database_error)?;
        if input.expected_revision != Some(actual_revision) {
            return Err(format!(
                "文档版本冲突：当前 revision 为 {actual_revision}，请求为 {:?}。",
                input.expected_revision
            ));
        }
        let result = sqlx::query(
            "UPDATE documents SET parent_id = ?, document_kind = ?, title = ?, source_url = ?, \
             author = ?, description = ?, content_json = ?, plain_text = ?, schema_version = 2, \
             revision = revision + 1, sort_order = ?, is_deleted = ?, updated_at = ? \
             WHERE id = ? AND revision = ?",
        )
        .bind(&input.parent_id)
        .bind(&input.document_kind)
        .bind(&input.title)
        .bind(&input.source_url)
        .bind(&input.author)
        .bind(&input.description)
        .bind(&projection.content_json)
        .bind(&projection.plain_text)
        .bind(input.sort_order)
        .bind(i64::from(input.is_deleted))
        .bind(input.updated_at)
        .bind(&input.id)
        .bind(actual_revision)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if result.rows_affected() != 1 {
            return Err("文档在写入时发生变化。".to_string());
        }
        actual_revision + 1
    } else {
        if input.expected_revision.is_some() {
            return Err("目标文档不存在。".to_string());
        }
        sqlx::query(
            "INSERT INTO documents (id, parent_id, document_kind, title, source_url, author, \
             description, content_json, plain_text, schema_version, revision, sort_order, \
             is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 1, ?, ?, ?, ?)",
        )
        .bind(&input.id)
        .bind(&input.parent_id)
        .bind(&input.document_kind)
        .bind(&input.title)
        .bind(&input.source_url)
        .bind(&input.author)
        .bind(&input.description)
        .bind(&projection.content_json)
        .bind(&projection.plain_text)
        .bind(input.sort_order)
        .bind(i64::from(input.is_deleted))
        .bind(input.updated_at)
        .bind(input.updated_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        1
    };
    sync_document_tags(&mut transaction, &input.id, &input.tags, input.updated_at).await?;
    replace_block_projection(
        &mut transaction,
        &input.id,
        revision,
        input.updated_at,
        &input.document_kind,
        input.is_deleted,
        &projection,
    )
    .await?;
    transaction.commit().await.map_err(database_error)?;
    Ok(PersistDocumentResult {
        id: input.id,
        revision,
        plain_text: projection.plain_text,
        content_json: projection.content_json,
    })
}

#[tauri::command]
pub async fn rebuild_document_projections(
    app: AppHandle,
    input: RebuildDocumentProjectionsInput,
) -> Result<RebuildDocumentProjectionsResult, String> {
    let pool = open_database(&app, input.data_directory).await?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let rows = if let Some(document_id) = input.document_id.as_deref() {
        sqlx::query(
            "SELECT id, document_kind, content_json, plain_text, revision, is_deleted, updated_at \
             FROM documents WHERE id = ?",
        )
        .bind(document_id)
        .fetch_all(&mut *transaction)
        .await
        .map_err(database_error)?
    } else {
        sqlx::query(
            "SELECT id, document_kind, content_json, plain_text, revision, is_deleted, updated_at \
             FROM documents ORDER BY id",
        )
        .fetch_all(&mut *transaction)
        .await
        .map_err(database_error)?
    };
    let mut result = RebuildDocumentProjectionsResult {
        scanned: rows.len(),
        repaired: 0,
        errors: Vec::new(),
    };
    for row in rows {
        let id: String = row.try_get("id").map_err(database_error)?;
        let document_kind: String = row.try_get("document_kind").map_err(database_error)?;
        let content_json: String = row.try_get("content_json").map_err(database_error)?;
        let stored_plain_text: String = row.try_get("plain_text").map_err(database_error)?;
        let revision: i64 = row.try_get("revision").map_err(database_error)?;
        let is_deleted: bool = row
            .try_get::<i64, _>("is_deleted")
            .map_err(database_error)?
            != 0;
        let updated_at: i64 = row.try_get("updated_at").map_err(database_error)?;
        let projection = match validate_and_project_tiptap(
            &content_json,
            document_kind == "article" && !is_deleted,
        ) {
            Ok(projection) => projection,
            Err(error) => {
                result.errors.push(format!("{id}: {error}"));
                continue;
            }
        };
        let stored_block_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE document_id = ?")
                .bind(&id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(database_error)?;
        let blocks_match = stored_block_count == projection.blocks.len() as i64
            && block_projection_matches(&mut transaction, &id, revision, &projection).await?;
        let fts_match: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM document_search \
             WHERE document_id = ? AND plain_text = ?",
        )
        .bind(&id)
        .bind(&projection.plain_text)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        let fts_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM document_search WHERE document_id = ?")
                .bind(&id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(database_error)?;
        let expected_fts_count = i64::from(!is_deleted);
        if stored_plain_text == projection.plain_text
            && blocks_match
            && fts_count == expected_fts_count
            && fts_match == expected_fts_count
        {
            continue;
        }
        sqlx::query("UPDATE documents SET plain_text = ? WHERE id = ?")
            .bind(&projection.plain_text)
            .bind(&id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        replace_block_projection(
            &mut transaction,
            &id,
            revision,
            updated_at,
            &document_kind,
            is_deleted,
            &projection,
        )
        .await?;
        result.repaired += 1;
    }
    transaction.commit().await.map_err(database_error)?;
    Ok(result)
}

async fn block_projection_matches(
    transaction: &mut Transaction<'_, Sqlite>,
    document_id: &str,
    revision: i64,
    projection: &ProjectedDocument,
) -> Result<bool, String> {
    for block in &projection.blocks {
        let matches: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE document_id = ? AND id = ? AND block_type = ? \
             AND block_index = ? AND content_json = ? AND plain_text = ? AND document_revision = ?",
        )
        .bind(document_id)
        .bind(&block.id)
        .bind(&block.block_type)
        .bind(block.block_index)
        .bind(&block.content_json)
        .bind(&block.plain_text)
        .bind(revision)
        .fetch_one(&mut **transaction)
        .await
        .map_err(database_error)?;
        if matches != 1 {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn validate_and_project_tiptap(
    content_json: &str,
    require_block_ids: bool,
) -> Result<ProjectedDocument, String> {
    let value: Value =
        serde_json::from_str(content_json).map_err(|error| format!("Tiptap JSON 无效：{error}"))?;
    let root = value
        .as_object()
        .filter(|object| object.get("type").and_then(Value::as_str) == Some("doc"))
        .ok_or_else(|| "Tiptap JSON 根节点必须是 doc。".to_string())?;
    let content = match root.get("content") {
        Some(Value::Array(content)) => content.as_slice(),
        Some(_) => return Err("Tiptap doc.content 必须是数组。".to_string()),
        None => &[],
    };
    let mut ids = HashSet::new();
    let mut blocks = Vec::with_capacity(content.len());
    for (index, node) in content.iter().enumerate() {
        let object = node
            .as_object()
            .ok_or_else(|| format!("顶层块 {index} 必须是对象。"))?;
        let block_type = object
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("顶层块 {index} 缺少 type。"))?;
        let id = object
            .get("attrs")
            .and_then(Value::as_object)
            .and_then(|attrs| attrs.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if require_block_ids && id.is_none() {
            return Err(format!("顶层块 {index} 缺少稳定 block id。"));
        }
        let Some(id) = id else { continue };
        if !ids.insert(id.to_string()) {
            return Err(format!("稳定 block id 重复：{id}"));
        }
        blocks.push(ProjectedBlock {
            id: id.to_string(),
            block_type: block_type.to_string(),
            block_index: index as i64,
            content_json: serde_json::to_string(node).map_err(database_error)?,
            plain_text: project_node_text(node).trim().to_string(),
        });
    }
    let plain_text = content
        .iter()
        .map(project_node_text)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ProjectedDocument {
        content_json: serde_json::to_string(&value).map_err(database_error)?,
        plain_text,
        blocks,
    })
}

fn project_node_text(node: &Value) -> String {
    let Some(object) = node.as_object() else {
        return String::new();
    };
    if let Some(text) = object.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    let node_type = object.get("type").and_then(Value::as_str).unwrap_or("");
    if node_type == "hardBreak" {
        return "\n".to_string();
    }
    if let Some(latex) = object
        .get("attrs")
        .and_then(Value::as_object)
        .and_then(|attrs| attrs.get("latex"))
        .and_then(Value::as_str)
    {
        if !latex.trim().is_empty() {
            return latex.to_string();
        }
    }
    let separator = match node_type {
        "table" | "tableCell" | "tableHeader" | "bulletList" | "orderedList" | "taskList" => "\n",
        "tableRow" => "\t",
        _ => "",
    };
    object
        .get("content")
        .and_then(Value::as_array)
        .map(|children| {
            children
                .iter()
                .map(project_node_text)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(separator)
        })
        .unwrap_or_default()
}

pub async fn replace_block_projection(
    transaction: &mut Transaction<'_, Sqlite>,
    document_id: &str,
    revision: i64,
    updated_at: i64,
    document_kind: &str,
    is_deleted: bool,
    projection: &ProjectedDocument,
) -> Result<(), String> {
    sqlx::query("DELETE FROM blocks WHERE document_id = ?")
        .bind(document_id)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    if document_kind != "article" || is_deleted {
        return Ok(());
    }
    for block in &projection.blocks {
        sqlx::query(
            "INSERT INTO blocks (document_id, id, block_type, block_index, content_json, \
             plain_text, document_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(document_id)
        .bind(&block.id)
        .bind(&block.block_type)
        .bind(block.block_index)
        .bind(&block.content_json)
        .bind(&block.plain_text)
        .bind(revision)
        .bind(updated_at)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

pub async fn sync_document_tags(
    transaction: &mut Transaction<'_, Sqlite>,
    document_id: &str,
    tags: &[String],
    created_at: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM document_tags WHERE document_id = ?")
        .bind(document_id)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    let mut normalized = Vec::new();
    for tag in tags {
        let value: String = tag.trim().chars().take(40).collect();
        if !value.is_empty() && !normalized.iter().any(|item| item == &value) {
            normalized.push(value);
        }
        if normalized.len() == 20 {
            break;
        }
    }
    for tag in normalized {
        sqlx::query(
            "INSERT INTO tags (id, name, created_at) \
             VALUES ('tag-' || lower(hex(randomblob(16))), ?, ?) \
             ON CONFLICT(name) DO NOTHING",
        )
        .bind(&tag)
        .bind(created_at)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "INSERT OR IGNORE INTO document_tags (document_id, tag_id, created_at) \
             SELECT ?, id, ? FROM tags WHERE name = ? LIMIT 1",
        )
        .bind(document_id)
        .bind(created_at)
        .bind(&tag)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_stable_blocks_and_complex_text_deterministically() {
        let projected = validate_and_project_tiptap(
            r#"{"type":"doc","content":[{"type":"heading","attrs":{"id":"h1"},"content":[{"type":"text","text":"标题"}]},{"type":"table","attrs":{"id":"t1"},"content":[{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"甲"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"乙"}]}]}]}]},{"type":"mathBlock","attrs":{"id":"m1","latex":"x^2"}}]}"#,
            true,
        )
        .unwrap();
        assert_eq!(projected.plain_text, "标题\n甲\t乙\nx^2");
        assert_eq!(projected.blocks.len(), 3);
        assert_eq!(projected.blocks[1].plain_text, "甲\t乙");
    }

    #[test]
    fn rejects_missing_or_duplicate_stable_block_ids() {
        let missing =
            validate_and_project_tiptap(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#, true)
                .unwrap_err();
        assert!(missing.contains("缺少稳定 block id"));
        let duplicate = validate_and_project_tiptap(
            r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"same"}},{"type":"heading","attrs":{"id":"same"}}]}"#,
            true,
        )
        .unwrap_err();
        assert!(duplicate.contains("重复"));
    }
}
