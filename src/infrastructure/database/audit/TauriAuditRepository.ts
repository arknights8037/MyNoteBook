import type { AuditCategory, AuditEntry, AuditQuery, AuditSeverity } from '@/models/shared/audit'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { AuditRepository } from '@/repositories/audit/AuditRepository'
import type { SqlClient } from '@/repositories/shared/SqlClient'

interface AuditRow extends Record<string, unknown> {
  id: string
  category: string
  entity_id: string
  title: string
  summary: string
  status: string
  details_json: string | null
  created_at: number
  completed_at: number | null
}

export class TauriAuditRepository implements AuditRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async listEntries(query: AuditQuery = {}): Promise<AppResult<AuditEntry[]>> {
    const limit = Math.max(1, Math.min(query.limit ?? 200, 500))
    const category = query.category ?? 'all'
    const search = query.search?.trim().toLocaleLowerCase() ?? ''
    try {
      const rows = await this.sqlClient.select<AuditRow>(
        `SELECT * FROM (
          SELECT id, 'agent_task' AS category, id AS entity_id, 'Agent 任务' AS title,
                 user_instruction AS summary, status, error AS details_json,
                 created_at, completed_at
          FROM agent_tasks
          UNION ALL
          SELECT id, 'tool_call', task_id, tool_name,
                 COALESCE(error, '工具调用') AS summary, status,
                 COALESCE(result_json, arguments_json), started_at, completed_at
          FROM agent_tool_calls
          UNION ALL
          SELECT CAST(id AS TEXT), 'confirmation', task_id, '确认事件', action,
                 action, details_json, created_at, created_at
          FROM agent_confirmations
          UNION ALL
          SELECT run.id, 'automation_run', COALESCE(run.automation_id, run.id),
                 COALESCE(task.name, '已删除的自动化'), run.trigger_source, run.status,
                 COALESCE(run.output_json, run.input_json), run.queued_at, run.completed_at
          FROM automation_runs run
          LEFT JOIN automation_tasks task ON task.id = run.automation_id
          UNION ALL
          SELECT id, 'task_run', id, 'TaskRun',
                 COALESCE(error, '统一任务运行'), status,
                 json_object('correlationId', correlation_id, 'causationId', causation_id,
                   'contextBundleId', context_bundle_id),
                 queued_at, completed_at
           FROM task_runs
           WHERE id NOT IN (
             SELECT task_run_id FROM agent_tasks WHERE task_run_id IS NOT NULL
             UNION
             SELECT task_run_id FROM automation_runs WHERE task_run_id IS NOT NULL
           )
          UNION ALL
          SELECT id, 'knowledge', id, object_type || ': ' || title,
                 authority_level, status,
                 json_object('documentId', document_id, 'blockId', block_id,
                   'sourceRevision', source_revision, 'version', version),
                 created_at, updated_at
          FROM knowledge_objects
          UNION ALL
          SELECT id, 'verification', task_run_id, '结果验证', summary, verdict,
                 checks_json, created_at, created_at
          FROM result_verifications
          UNION ALL
          SELECT id, 'change_set', COALESCE(task_run_id, id), title, description, status,
                 json_object('agentTaskId', agent_task_id, 'patchSetTaskId', patch_set_task_id),
                 created_at, updated_at
          FROM change_sets
          UNION ALL
          SELECT id, 'approval', entity_id, '审批', entity_type, decision,
                 details_json, created_at, created_at
          FROM approvals
          UNION ALL
          SELECT id, 'view_refresh', view_id, 'View 刷新', source_snapshot_hash, status,
                 render_json, created_at, created_at
          FROM view_snapshots
          UNION ALL
          SELECT id, 'delegation', task_run_id, '外部委派', external_actor_id, status,
                 json_object('delegateType', delegate_type, 'allowedOperations', allowed_operations_json,
                   'expiresAt', expires_at, 'correlationId', correlation_id),
                 created_at, updated_at
          FROM delegations
          UNION ALL
          SELECT id, 'domain_event', aggregate_id, event_type, aggregate_type, 'recorded',
                 payload_json, occurred_at, occurred_at
          FROM domain_events
          UNION ALL
          SELECT id, 'outbox', event_id, topic, COALESCE(last_error, '事件投递'), status,
                 payload_json, created_at, published_at
          FROM outbox_messages
        )
        WHERE (? = 'all' OR category = ?)
          AND (? = '' OR instr(lower(title || char(10) || summary || char(10) || status), ?) > 0)
        ORDER BY created_at DESC LIMIT ?`,
        [category, category, search, search, limit],
      )
      return ok(rows.map(mapAuditRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取审计记录。'))
    }
  }
}

function mapAuditRow(row: AuditRow): AuditEntry {
  const category = [
    'agent_task',
    'tool_call',
    'confirmation',
    'automation_run',
    'task_run',
    'knowledge',
    'verification',
    'change_set',
    'approval',
    'view_refresh',
    'delegation',
    'domain_event',
    'outbox',
  ].includes(row.category)
    ? (row.category as AuditCategory)
    : 'agent_task'
  return {
    id: `${category}:${row.id}`,
    category,
    entityId: row.entity_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    severity: severityForStatus(row.status),
    detailsJson: row.details_json,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function severityForStatus(status: string): AuditSeverity {
  if (['failed', 'error', 'rejected', 'invalid'].includes(status)) return 'error'
  if (
    [
      'completed',
      'accepted',
      'approved',
      'applied',
      'rolled_back',
      'passed',
      'fresh',
      'active',
      'published',
      'recorded',
    ].includes(status)
  )
    return 'success'
  if (
    [
      'running',
      'queued',
      'waiting_confirmation',
      'waiting_approval',
      'needs_approval',
      'stale',
      'blocked',
    ].includes(status)
  )
    return 'warning'
  return 'info'
}
