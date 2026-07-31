import type { DatabaseMutation } from '@/repositories/shared/SqlClient'

// Repository tests execute the same fixed catalog against in-memory SQLite. Production never
// imports this helper; its writer is the Rust execute_database_mutation command.
export const TEST_DATABASE_MUTATIONS: Partial<Record<DatabaseMutation, string>> = {
  hardDeleteDocument: 'DELETE FROM documents WHERE id = ? AND revision = ? AND is_deleted = 1',
  createAgentTask:
    'INSERT INTO agent_tasks (id, run_id, workflow_id, session_id, document_id, status, user_instruction, context_scope, model, current_step, error, created_at, completed_at, correlation_id, causation_id, execution_policy_json, context_bundle_id, provider, project_id, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  markInterruptedAgentTasks:
    "UPDATE agent_tasks SET status = 'failed', current_step = '任务因应用中断而停止', error = '应用在任务完成前关闭。', completed_at = ? WHERE status IN ('pending', 'running')",
  updateAgentTask:
    'UPDATE agent_tasks SET status = ?, current_step = ?, error = ?, completed_at = ? WHERE id = ?',
  upsertAgentToolCall:
    'INSERT INTO agent_tool_calls (id, task_id, run_id, turn_id, provider_tool_call_id, tool_name, arguments_json, result_json, status, started_at, completed_at, error, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET result_json = excluded.result_json, status = excluded.status, completed_at = excluded.completed_at, error = excluded.error',
  saveAgentWorkspaceState:
    "INSERT INTO agent_workspace_state (id, state_json, updated_at) VALUES ('current', ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  createAutomationTask:
    'INSERT INTO automation_tasks (id, name, instruction, trigger_type, trigger_config_json, source_type, source_config_json, source_cursor_at, document_id, enabled, next_run_at, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  setAutomationTaskEnabled:
    'UPDATE automation_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
  deleteAutomationTask: 'DELETE FROM automation_tasks WHERE id = ?',
  enqueueAutomationRun:
    'INSERT INTO automation_runs (id, automation_id, trigger_source, status, input_json, output_json, error, schedule_next_run_at, queued_at, started_at, completed_at, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  updateAutomationRun:
    'UPDATE automation_runs SET status = ?, started_at = COALESCE(?, started_at), completed_at = ?, output_json = ?, error = ? WHERE id = ?',
  createWorkspaceView:
    'INSERT INTO workspace_views (id, parent_id, sort_order, view_type, title, payload_json, schema_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
  updateWorkspaceView:
    'UPDATE workspace_views SET title = ?, payload_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
  moveWorkspaceView:
    'UPDATE workspace_views SET parent_id = ?, sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
  setWorkspaceViewPinned: 'UPDATE workspace_views SET pinned_at = ? WHERE id = ?',
  deleteWorkspaceView: 'DELETE FROM workspace_views WHERE id = ?',
  createMindMap:
    'INSERT INTO mind_maps (id, parent_id, sort_order, title, content_json, schema_version, version, last_actor_type, last_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)',
  moveMindMap:
    'UPDATE mind_maps SET parent_id = ?, sort_order = ?, version = version + 1, last_actor_type = ?, last_actor_id = ?, updated_at = ? WHERE id = ? AND version = ?',
  updateMindMap:
    'UPDATE mind_maps SET title = ?, content_json = ?, version = version + 1, last_actor_type = ?, last_actor_id = ?, updated_at = ? WHERE id = ? AND version = ?',
  deleteMindMap: 'DELETE FROM mind_maps WHERE id = ?',
  createInformationHome:
    "INSERT OR IGNORE INTO information_home (id, payload_json, schema_version, version, auto_summary_enabled, summary_interval_minutes, created_at, updated_at) VALUES ('default', ?, 1, 1, ?, ?, ?, ?)",
  updateInformationHomePayload:
    "UPDATE information_home SET payload_json = ?, version = version + 1, updated_at = ? WHERE id = 'default' AND version = ?",
  updateInformationHomeSettings:
    "UPDATE information_home SET auto_summary_enabled = ?, summary_interval_minutes = ?, version = version + 1, updated_at = ? WHERE id = 'default'",
  createInformationHomeSummary:
    "INSERT INTO information_home_summaries (id, home_id, source_cursor_at, trigger_source, status, content, provider, model, error, generated_at) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)",
  createEmailAccount:
    "INSERT INTO email_accounts (id, display_name, email_address, imap_host, imap_port, username, mailbox, auth_type, source_category, enabled, last_synced_at, sync_cursor_at, last_remote_uid, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'password', ?, 1, NULL, NULL, 0, NULL, ?, ?)",
  deleteEmailAccount: 'DELETE FROM email_accounts WHERE id = ?',
  updateEmailSyncState:
    'UPDATE email_accounts SET last_synced_at = ?, sync_cursor_at = COALESCE(?, sync_cursor_at), last_remote_uid = COALESCE(?, last_remote_uid), last_error = ?, updated_at = ? WHERE id = ?',
  updateEmailCategory: 'UPDATE email_accounts SET source_category = ?, updated_at = ? WHERE id = ?',
  upsertEmailMessage:
    'INSERT INTO email_messages (id, account_id, mailbox, remote_uid, message_id, subject, from_name, from_address, to_json, received_at, preview, body_text, attachment_count, server_is_read, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, mailbox, remote_uid) DO UPDATE SET message_id = excluded.message_id, subject = excluded.subject, from_name = excluded.from_name, from_address = excluded.from_address, to_json = excluded.to_json, received_at = excluded.received_at, preview = excluded.preview, body_text = excluded.body_text, attachment_count = excluded.attachment_count, server_is_read = excluded.server_is_read, synced_at = excluded.synced_at',
  setEmailMessageStatus: 'UPDATE email_messages SET processing_status = ? WHERE id = ?',
  deleteEmailMessage: 'DELETE FROM email_messages WHERE id = ?',
  blockEmailSender:
    'INSERT INTO email_blocked_senders (account_id, sender_address, created_at) VALUES (?, ?, ?) ON CONFLICT(account_id, sender_address) DO UPDATE SET created_at = excluded.created_at',
  unblockEmailSender:
    'DELETE FROM email_blocked_senders WHERE account_id = ? AND sender_address = ? COLLATE NOCASE',
  createImConnector:
    "INSERT INTO im_connectors (id, provider, display_name, source_category, client_id, enabled, runtime_status, last_connected_at, last_event_at, last_error, created_at, updated_at) VALUES (?, 'dingtalk', ?, ?, ?, 1, 'stopped', NULL, NULL, NULL, ?, ?)",
  deleteImConnector: 'DELETE FROM im_connectors WHERE id = ?',
  updateImCategory: 'UPDATE im_connectors SET source_category = ?, updated_at = ? WHERE id = ?',
  setImConnectorEnabled:
    'UPDATE im_connectors SET enabled = ?, runtime_status = ?, last_error = NULL, updated_at = ? WHERE id = ?',
  setImMessageStatus: 'UPDATE im_messages SET processing_status = ? WHERE id = ?',
  createRssSource:
    'INSERT INTO rss_sources (id, display_name, feed_url, site_url, description, etag, last_modified, source_category, enabled, last_synced_at, sync_cursor_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)',
  deleteRssSource: 'DELETE FROM rss_sources WHERE id = ?',
  updateRssSyncState:
    'UPDATE rss_sources SET site_url = COALESCE(?, site_url), description = COALESCE(?, description), etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), last_synced_at = ?, sync_cursor_at = COALESCE(?, sync_cursor_at), last_error = ?, updated_at = ? WHERE id = ?',
  updateRssCategory: 'UPDATE rss_sources SET source_category = ?, updated_at = ? WHERE id = ?',
  upsertRssEntry:
    "INSERT INTO rss_entries (id, source_id, remote_id, article_url, title, author, published_at, updated_at, preview, body_text, content_source, article_fetched_at, article_fetch_error, categories_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, remote_id) DO UPDATE SET article_url = excluded.article_url, title = excluded.title, author = excluded.author, published_at = excluded.published_at, updated_at = excluded.updated_at, preview = excluded.preview, body_text = CASE WHEN excluded.content_source = 'article' OR rss_entries.content_source != 'article' THEN excluded.body_text ELSE rss_entries.body_text END, content_source = CASE WHEN excluded.content_source = 'article' OR rss_entries.content_source != 'article' THEN excluded.content_source ELSE rss_entries.content_source END, article_fetched_at = COALESCE(excluded.article_fetched_at, rss_entries.article_fetched_at), article_fetch_error = CASE WHEN excluded.content_source = 'article' THEN NULL WHEN rss_entries.content_source = 'article' THEN rss_entries.article_fetch_error ELSE excluded.article_fetch_error END, categories_json = excluded.categories_json, synced_at = excluded.synced_at",
  setRssEntryStatus: 'UPDATE rss_entries SET processing_status = ? WHERE id = ?',
  updateRssArticleContent:
    "UPDATE rss_entries SET body_text = ?, content_source = 'article', article_fetched_at = ?, article_fetch_error = NULL WHERE id = ?",
  createKnowledgeObject:
    'INSERT INTO knowledge_objects (id, object_type, status, title, content, structured_data_json, generated_run_id, cognitive_mode, template_id, template_version, owner_id, scope_json, document_id, block_id, source_revision, authority_level, confidence, valid_from, valid_until, verified_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  updateKnowledgeObject:
    'UPDATE knowledge_objects SET status = ?, title = ?, content = ?, structured_data_json = ?, generated_run_id = ?, cognitive_mode = ?, template_id = ?, template_version = ?, owner_id = ?, scope_json = ?, document_id = ?, block_id = ?, source_revision = ?, authority_level = ?, confidence = ?, valid_from = ?, valid_until = ?, verified_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
  deleteKnowledgeRelations:
    'DELETE FROM knowledge_object_relations WHERE from_object_id = ? OR to_object_id = ?',
  deleteKnowledgeSources: 'DELETE FROM knowledge_object_sources WHERE knowledge_object_id = ?',
  deleteKnowledgeValidations: 'DELETE FROM knowledge_validations WHERE knowledge_object_id = ?',
  deleteKnowledgeObject: 'DELETE FROM knowledge_objects WHERE id = ? AND version = ?',
  addKnowledgeRelation:
    'INSERT INTO knowledge_object_relations (id, from_object_id, relation_type, to_object_id, created_at) VALUES (?, ?, ?, ?, ?)',
  addKnowledgeSource:
    'INSERT INTO knowledge_object_sources (id, knowledge_object_id, document_id, block_id, revision, quote, start_offset, end_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  addKnowledgeValidation:
    'INSERT INTO knowledge_validations (id, knowledge_object_id, rule_id, verdict, severity, message, source_json, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  createTaskDefinition:
    'INSERT INTO task_definitions (id, definition_type, name, instruction, acceptance_criteria_json, execution_policy_json, source_knowledge_object_id, automation_id, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)',
  createTaskRun:
    'INSERT INTO task_runs (id, task_definition_id, status, frozen_input_json, acceptance_criteria_json, output_json, error, context_bundle_id, correlation_id, causation_id, queued_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)',
  updateTaskRun:
    'UPDATE task_runs SET status = ?, output_json = COALESCE(?, output_json), error = ?, started_at = COALESCE(?, started_at), completed_at = ? WHERE id = ? AND status = ?',
  addWorkArtifact:
    'INSERT INTO work_artifacts (id, task_run_id, artifact_type, name, uri, content_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  addWorkEvidence:
    'INSERT INTO work_evidence (id, task_run_id, evidence_type, status, document_id, block_id, source_revision, artifact_id, claim, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  createChangeSet:
    'INSERT INTO change_sets (id, task_run_id, agent_task_id, status, title, description, patch_set_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
}

export function testDatabaseMutationSql(mutation: DatabaseMutation): string {
  const sql = TEST_DATABASE_MUTATIONS[mutation]
  if (!sql) throw new Error(`Missing test SQL for database mutation ${mutation}`)
  return sql
}
