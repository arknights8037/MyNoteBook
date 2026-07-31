use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{query::Query, sqlite::SqliteArguments, Sqlite, SqlitePool};
use tauri::AppHandle;

use crate::database::{database_error, open_database};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseMutation {
    UpsertAsset,
    DeleteAsset,
    HardDeleteDocument,
    CreateAgentTask,
    MarkInterruptedAgentTasks,
    UpdateAgentTask,
    UpsertAgentToolCall,
    SaveAgentWorkspaceState,
    CreateAutomationTask,
    SetAutomationTaskEnabled,
    DeleteAutomationTask,
    EnqueueAutomationRun,
    UpdateAutomationRun,
    CreateWorkspaceView,
    UpdateWorkspaceView,
    MoveWorkspaceView,
    SetWorkspaceViewPinned,
    DeleteWorkspaceView,
    CreateMindMap,
    MoveMindMap,
    UpdateMindMap,
    DeleteMindMap,
    CreateInformationHome,
    UpdateInformationHomePayload,
    UpdateInformationHomeSettings,
    CreateInformationHomeSummary,
    CreateEmailAccount,
    DeleteEmailAccount,
    UpdateEmailSyncState,
    UpdateEmailCategory,
    UpsertEmailMessage,
    SetEmailMessageStatus,
    DeleteEmailMessage,
    BlockEmailSender,
    UnblockEmailSender,
    CreateImConnector,
    DeleteImConnector,
    UpdateImCategory,
    SetImConnectorEnabled,
    SetImMessageStatus,
    CreateRssSource,
    DeleteRssSource,
    UpdateRssSyncState,
    UpdateRssCategory,
    UpsertRssEntry,
    SetRssEntryStatus,
    UpdateRssArticleContent,
    CreateKnowledgeObject,
    UpdateKnowledgeObject,
    DeleteKnowledgeRelations,
    DeleteKnowledgeSources,
    DeleteKnowledgeValidations,
    DeleteKnowledgeObject,
    AddKnowledgeRelation,
    AddKnowledgeSource,
    AddKnowledgeValidation,
    CreateViewDefinition,
    CreateTaskDefinition,
    CreateTaskRun,
    UpdateTaskRun,
    AddWorkArtifact,
    AddWorkEvidence,
    CreateChangeSet,
}

impl DatabaseMutation {
    fn statement(self) -> (&'static str, usize) {
        match self {
            Self::UpsertAsset => (
                "INSERT INTO assets (id, document_id, relative_path, original_name, mime_type, size_bytes, content_hash, width, height, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document_id = excluded.document_id, relative_path = excluded.relative_path, original_name = excluded.original_name, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes, content_hash = excluded.content_hash, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at",
                11,
            ),
            Self::DeleteAsset => ("DELETE FROM assets WHERE id = ?", 1),
            Self::HardDeleteDocument => (
                "DELETE FROM documents WHERE id = ? AND revision = ? AND is_deleted = 1",
                2,
            ),
            Self::CreateAgentTask => (
                "INSERT INTO agent_tasks (id, run_id, workflow_id, session_id, document_id, status, user_instruction, context_scope, model, current_step, error, created_at, completed_at, correlation_id, causation_id, execution_policy_json, context_bundle_id, provider, project_id, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                20,
            ),
            Self::MarkInterruptedAgentTasks => (
                "UPDATE agent_tasks SET status = 'failed', current_step = '任务因应用中断而停止', error = '应用在任务完成前关闭。', completed_at = ? WHERE status IN ('pending', 'running')",
                1,
            ),
            Self::UpdateAgentTask => (
                "UPDATE agent_tasks SET status = ?, current_step = ?, error = ?, completed_at = ? WHERE id = ?",
                5,
            ),
            Self::UpsertAgentToolCall => (
                "INSERT INTO agent_tool_calls (id, task_id, run_id, turn_id, provider_tool_call_id, tool_name, arguments_json, result_json, status, started_at, completed_at, error, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET result_json = excluded.result_json, status = excluded.status, completed_at = excluded.completed_at, error = excluded.error",
                14,
            ),
            Self::SaveAgentWorkspaceState => (
                "INSERT INTO agent_workspace_state (id, state_json, updated_at) VALUES ('current', ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
                2,
            ),
            Self::CreateAutomationTask => (
                "INSERT INTO automation_tasks (id, name, instruction, trigger_type, trigger_config_json, source_type, source_config_json, source_cursor_at, document_id, enabled, next_run_at, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                14,
            ),
            Self::SetAutomationTaskEnabled => (
                "UPDATE automation_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
                4,
            ),
            Self::DeleteAutomationTask => ("DELETE FROM automation_tasks WHERE id = ?", 1),
            Self::EnqueueAutomationRun => (
                "INSERT INTO automation_runs (id, automation_id, trigger_source, status, input_json, output_json, error, schedule_next_run_at, queued_at, started_at, completed_at, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                13,
            ),
            Self::UpdateAutomationRun => (
                "UPDATE automation_runs SET status = ?, started_at = COALESCE(?, started_at), completed_at = ?, output_json = ?, error = ? WHERE id = ?",
                6,
            ),
            Self::CreateWorkspaceView => (
                "INSERT INTO workspace_views (id, parent_id, sort_order, view_type, title, payload_json, schema_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
                8,
            ),
            Self::UpdateWorkspaceView => (
                "UPDATE workspace_views SET title = ?, payload_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
                5,
            ),
            Self::MoveWorkspaceView => (
                "UPDATE workspace_views SET parent_id = ?, sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
                5,
            ),
            Self::SetWorkspaceViewPinned => {
                ("UPDATE workspace_views SET pinned_at = ? WHERE id = ?", 2)
            }
            Self::DeleteWorkspaceView => ("DELETE FROM workspace_views WHERE id = ?", 1),
            Self::CreateMindMap => (
                "INSERT INTO mind_maps (id, parent_id, sort_order, title, content_json, schema_version, version, last_actor_type, last_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)",
                9,
            ),
            Self::MoveMindMap => (
                "UPDATE mind_maps SET parent_id = ?, sort_order = ?, version = version + 1, last_actor_type = ?, last_actor_id = ?, updated_at = ? WHERE id = ? AND version = ?",
                7,
            ),
            Self::UpdateMindMap => (
                "UPDATE mind_maps SET title = ?, content_json = ?, version = version + 1, last_actor_type = ?, last_actor_id = ?, updated_at = ? WHERE id = ? AND version = ?",
                7,
            ),
            Self::DeleteMindMap => ("DELETE FROM mind_maps WHERE id = ?", 1),
            Self::CreateInformationHome => (
                "INSERT OR IGNORE INTO information_home (id, payload_json, schema_version, version, auto_summary_enabled, summary_interval_minutes, created_at, updated_at) VALUES ('default', ?, 1, 1, ?, ?, ?, ?)",
                5,
            ),
            Self::UpdateInformationHomePayload => (
                "UPDATE information_home SET payload_json = ?, version = version + 1, updated_at = ? WHERE id = 'default' AND version = ?",
                3,
            ),
            Self::UpdateInformationHomeSettings => (
                "UPDATE information_home SET auto_summary_enabled = ?, summary_interval_minutes = ?, version = version + 1, updated_at = ? WHERE id = 'default'",
                3,
            ),
            Self::CreateInformationHomeSummary => (
                "INSERT INTO information_home_summaries (id, home_id, source_cursor_at, trigger_source, status, content, provider, model, error, generated_at) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)",
                9,
            ),
            Self::CreateEmailAccount => (
                "INSERT INTO email_accounts (id, display_name, email_address, imap_host, imap_port, username, mailbox, auth_type, source_category, enabled, last_synced_at, sync_cursor_at, last_remote_uid, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'password', ?, 1, NULL, NULL, 0, NULL, ?, ?)",
                10,
            ),
            Self::DeleteEmailAccount => ("DELETE FROM email_accounts WHERE id = ?", 1),
            Self::UpdateEmailSyncState => (
                "UPDATE email_accounts SET last_synced_at = ?, sync_cursor_at = COALESCE(?, sync_cursor_at), last_remote_uid = COALESCE(?, last_remote_uid), last_error = ?, updated_at = ? WHERE id = ?",
                6,
            ),
            Self::UpdateEmailCategory => (
                "UPDATE email_accounts SET source_category = ?, updated_at = ? WHERE id = ?",
                3,
            ),
            Self::UpsertEmailMessage => (
                "INSERT INTO email_messages (id, account_id, mailbox, remote_uid, message_id, subject, from_name, from_address, to_json, received_at, preview, body_text, attachment_count, server_is_read, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, mailbox, remote_uid) DO UPDATE SET message_id = excluded.message_id, subject = excluded.subject, from_name = excluded.from_name, from_address = excluded.from_address, to_json = excluded.to_json, received_at = excluded.received_at, preview = excluded.preview, body_text = excluded.body_text, attachment_count = excluded.attachment_count, server_is_read = excluded.server_is_read, synced_at = excluded.synced_at",
                15,
            ),
            Self::SetEmailMessageStatus => {
                ("UPDATE email_messages SET processing_status = ? WHERE id = ?", 2)
            }
            Self::DeleteEmailMessage => ("DELETE FROM email_messages WHERE id = ?", 1),
            Self::BlockEmailSender => (
                "INSERT INTO email_blocked_senders (account_id, sender_address, created_at) VALUES (?, ?, ?) ON CONFLICT(account_id, sender_address) DO UPDATE SET created_at = excluded.created_at",
                3,
            ),
            Self::UnblockEmailSender => (
                "DELETE FROM email_blocked_senders WHERE account_id = ? AND sender_address = ? COLLATE NOCASE",
                2,
            ),
            Self::CreateImConnector => (
                "INSERT INTO im_connectors (id, provider, display_name, source_category, client_id, enabled, runtime_status, last_connected_at, last_event_at, last_error, created_at, updated_at) VALUES (?, 'dingtalk', ?, ?, ?, 1, 'stopped', NULL, NULL, NULL, ?, ?)",
                6,
            ),
            Self::DeleteImConnector => ("DELETE FROM im_connectors WHERE id = ?", 1),
            Self::UpdateImCategory => (
                "UPDATE im_connectors SET source_category = ?, updated_at = ? WHERE id = ?",
                3,
            ),
            Self::SetImConnectorEnabled => (
                "UPDATE im_connectors SET enabled = ?, runtime_status = ?, last_error = NULL, updated_at = ? WHERE id = ?",
                4,
            ),
            Self::SetImMessageStatus => {
                ("UPDATE im_messages SET processing_status = ? WHERE id = ?", 2)
            }
            Self::CreateRssSource => (
                "INSERT INTO rss_sources (id, display_name, feed_url, site_url, description, etag, last_modified, source_category, enabled, last_synced_at, sync_cursor_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)",
                12,
            ),
            Self::DeleteRssSource => ("DELETE FROM rss_sources WHERE id = ?", 1),
            Self::UpdateRssSyncState => (
                "UPDATE rss_sources SET site_url = COALESCE(?, site_url), description = COALESCE(?, description), etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), last_synced_at = ?, sync_cursor_at = COALESCE(?, sync_cursor_at), last_error = ?, updated_at = ? WHERE id = ?",
                9,
            ),
            Self::UpdateRssCategory => (
                "UPDATE rss_sources SET source_category = ?, updated_at = ? WHERE id = ?",
                3,
            ),
            Self::UpsertRssEntry => (
                "INSERT INTO rss_entries (id, source_id, remote_id, article_url, title, author, published_at, updated_at, preview, body_text, content_source, article_fetched_at, article_fetch_error, categories_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, remote_id) DO UPDATE SET article_url = excluded.article_url, title = excluded.title, author = excluded.author, published_at = excluded.published_at, updated_at = excluded.updated_at, preview = excluded.preview, body_text = CASE WHEN excluded.content_source = 'article' OR rss_entries.content_source != 'article' THEN excluded.body_text ELSE rss_entries.body_text END, content_source = CASE WHEN excluded.content_source = 'article' OR rss_entries.content_source != 'article' THEN excluded.content_source ELSE rss_entries.content_source END, article_fetched_at = COALESCE(excluded.article_fetched_at, rss_entries.article_fetched_at), article_fetch_error = CASE WHEN excluded.content_source = 'article' THEN NULL WHEN rss_entries.content_source = 'article' THEN rss_entries.article_fetch_error ELSE excluded.article_fetch_error END, categories_json = excluded.categories_json, synced_at = excluded.synced_at",
                15,
            ),
            Self::SetRssEntryStatus => {
                ("UPDATE rss_entries SET processing_status = ? WHERE id = ?", 2)
            }
            Self::UpdateRssArticleContent => (
                "UPDATE rss_entries SET body_text = ?, content_source = 'article', article_fetched_at = ?, article_fetch_error = NULL WHERE id = ?",
                3,
            ),
            Self::CreateKnowledgeObject => (
                "INSERT INTO knowledge_objects (id, object_type, status, title, content, structured_data_json, generated_run_id, cognitive_mode, template_id, template_version, owner_id, scope_json, document_id, block_id, source_revision, authority_level, confidence, valid_from, valid_until, verified_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                22,
            ),
            Self::UpdateKnowledgeObject => (
                "UPDATE knowledge_objects SET status = ?, title = ?, content = ?, structured_data_json = ?, generated_run_id = ?, cognitive_mode = ?, template_id = ?, template_version = ?, owner_id = ?, scope_json = ?, document_id = ?, block_id = ?, source_revision = ?, authority_level = ?, confidence = ?, valid_from = ?, valid_until = ?, verified_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
                21,
            ),
            Self::DeleteKnowledgeRelations => (
                "DELETE FROM knowledge_object_relations WHERE from_object_id = ? OR to_object_id = ?",
                2,
            ),
            Self::DeleteKnowledgeSources => {
                ("DELETE FROM knowledge_object_sources WHERE knowledge_object_id = ?", 1)
            }
            Self::DeleteKnowledgeValidations => {
                ("DELETE FROM knowledge_validations WHERE knowledge_object_id = ?", 1)
            }
            Self::DeleteKnowledgeObject => {
                ("DELETE FROM knowledge_objects WHERE id = ? AND version = ?", 2)
            }
            Self::AddKnowledgeRelation => (
                "INSERT INTO knowledge_object_relations (id, from_object_id, relation_type, to_object_id, created_at) VALUES (?, ?, ?, ?, ?)",
                5,
            ),
            Self::AddKnowledgeSource => (
                "INSERT INTO knowledge_object_sources (id, knowledge_object_id, document_id, block_id, revision, quote, start_offset, end_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                9,
            ),
            Self::AddKnowledgeValidation => (
                "INSERT INTO knowledge_validations (id, knowledge_object_id, rule_id, verdict, severity, message, source_json, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                8,
            ),
            Self::CreateViewDefinition => (
                "INSERT INTO view_definitions (id, name, view_type, scope_query_json, projection_schema_json, render_spec_json, refresh_policy, writeback_policy, target_document_id, stale, version, generation_prompt, generation_provider, generation_model, generation_skill_versions_json, last_refreshed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, 1, 1, ?, ?, ?, ?, NULL, ?, ?)",
                14,
            ),
            Self::CreateTaskDefinition => (
                "INSERT INTO task_definitions (id, definition_type, name, instruction, acceptance_criteria_json, execution_policy_json, source_knowledge_object_id, automation_id, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)",
                10,
            ),
            Self::CreateTaskRun => (
                "INSERT INTO task_runs (id, task_definition_id, status, frozen_input_json, acceptance_criteria_json, output_json, error, context_bundle_id, correlation_id, causation_id, queued_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)",
                8,
            ),
            Self::UpdateTaskRun => (
                "UPDATE task_runs SET status = ?, output_json = COALESCE(?, output_json), error = ?, started_at = COALESCE(?, started_at), completed_at = ? WHERE id = ? AND status = ?",
                7,
            ),
            Self::AddWorkArtifact => (
                "INSERT INTO work_artifacts (id, task_run_id, artifact_type, name, uri, content_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                8,
            ),
            Self::AddWorkEvidence => (
                "INSERT INTO work_evidence (id, task_run_id, evidence_type, status, document_id, block_id, source_revision, artifact_id, claim, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                11,
            ),
            Self::CreateChangeSet => (
                "INSERT INTO change_sets (id, task_run_id, agent_task_id, status, title, description, patch_set_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                9,
            ),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteDatabaseMutationInput {
    data_directory: Option<String>,
    mutation: DatabaseMutation,
    #[serde(default)]
    values: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteDatabaseMutationResult {
    rows_affected: u64,
    last_insert_id: i64,
}

#[tauri::command]
pub async fn execute_database_mutation(
    app: AppHandle,
    input: ExecuteDatabaseMutationInput,
) -> Result<ExecuteDatabaseMutationResult, String> {
    let pool = open_database(&app, input.data_directory).await?;
    execute_database_mutation_in_pool(pool.as_ref(), input.mutation, input.values).await
}

async fn execute_database_mutation_in_pool(
    pool: &SqlitePool,
    mutation: DatabaseMutation,
    values: Vec<Value>,
) -> Result<ExecuteDatabaseMutationResult, String> {
    let (statement, expected_values) = mutation.statement();
    if values.len() != expected_values {
        return Err(format!(
            "数据库写操作参数数量无效：期望 {expected_values}，实际 {}。",
            values.len()
        ));
    }
    let mut query = sqlx::query(statement);
    for value in values {
        query = bind_json_value(query, value)?;
    }
    let result = query.execute(pool).await.map_err(database_error)?;
    Ok(ExecuteDatabaseMutationResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}

fn bind_json_value<'q>(
    query: Query<'q, Sqlite, SqliteArguments<'q>>,
    value: Value,
) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>, String> {
    match value {
        Value::Null => Ok(query.bind(Option::<String>::None)),
        Value::Bool(value) => Ok(query.bind(value)),
        Value::String(value) => Ok(query.bind(value)),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(query.bind(value))
            } else if let Some(value) = value.as_u64() {
                let value = i64::try_from(value)
                    .map_err(|_| "数据库写操作整数超过 SQLite i64 范围。".to_string())?;
                Ok(query.bind(value))
            } else if let Some(value) = value.as_f64() {
                Ok(query.bind(value))
            } else {
                Err("数据库写操作包含无效数字。".to_string())
            }
        }
        Value::Array(_) | Value::Object(_) => Err("数据库写操作只接受标量绑定参数。".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn executes_only_catalogued_mutations_with_valid_arity() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        sqlx::query(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, document_id TEXT, relative_path TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, content_hash TEXT, width INTEGER, height INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("create assets");
        let result = execute_database_mutation_in_pool(
            &pool,
            DatabaseMutation::UpsertAsset,
            vec![
                Value::String("asset-1".into()),
                Value::Null,
                Value::String("assets/a.txt".into()),
                Value::String("a.txt".into()),
                Value::String("text/plain".into()),
                Value::from(4),
                Value::String("hash".into()),
                Value::Null,
                Value::Null,
                Value::from(1),
                Value::from(1),
            ],
        )
        .await
        .expect("upsert asset");
        assert_eq!(result.rows_affected, 1);

        let error =
            execute_database_mutation_in_pool(&pool, DatabaseMutation::DeleteAsset, Vec::new())
                .await
                .expect_err("reject invalid arity");
        assert!(error.contains("期望 1"));
    }
}
