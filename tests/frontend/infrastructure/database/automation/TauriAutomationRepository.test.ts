import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'

import { TauriAuditRepository } from '@/infrastructure/database/audit/TauriAuditRepository'
import { TauriAutomationRepository } from '@/infrastructure/database/automation/TauriAutomationRepository'
import type { AutomationRun } from '@/models/automation/automation'
import type {
  DatabaseMutation,
  SqlClient,
  SqlExecuteResult,
  SqlValue,
} from '@/repositories/shared/SqlClient'
import { testDatabaseMutationSql } from '../testDatabaseMutations'

class SqliteClient implements SqlClient {
  readonly database = new DatabaseSync(':memory:')

  async mutate(mutation: DatabaseMutation, bindValues: SqlValue[] = []): Promise<SqlExecuteResult> {
    const sql = testDatabaseMutationSql(mutation)
    const result = this.database.prepare(sql).run(...bindValues.map(toSqliteValue))
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) }
  }

  async select<T extends Record<string, unknown>>(
    sql: string,
    bindValues: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...bindValues.map(toSqliteValue)) as T[]
  }
}

function toSqliteValue(value: SqlValue): string | number | null {
  return typeof value === 'boolean' ? Number(value) : value
}

describe('automation and audit repositories', () => {
  let client: SqliteClient
  let repository: TauriAutomationRepository

  beforeEach(() => {
    client = new SqliteClient()
    client.database.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY);
      CREATE TABLE automation_tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instruction TEXT NOT NULL,
        trigger_type TEXT NOT NULL, trigger_config_json TEXT NOT NULL,
        document_id TEXT, enabled INTEGER NOT NULL, next_run_at INTEGER,
        last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT, trigger_source TEXT NOT NULL,
        status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, error TEXT,
        schedule_next_run_at INTEGER, queued_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER,
        correlation_id TEXT, causation_id TEXT, task_run_id TEXT
      );
      CREATE UNIQUE INDEX idx_automation_runs_active ON automation_runs(automation_id)
      WHERE automation_id IS NOT NULL AND status IN ('queued', 'running');
      CREATE TRIGGER automation_runs_after_insert AFTER INSERT ON automation_runs
      WHEN NEW.automation_id IS NOT NULL BEGIN
        UPDATE automation_tasks SET last_run_at = NEW.queued_at,
          next_run_at = NEW.schedule_next_run_at, updated_at = NEW.queued_at
        WHERE id = NEW.automation_id;
      END;
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY, user_instruction TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER, task_run_id TEXT
      );
      CREATE TABLE agent_tool_calls (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL, result_json TEXT, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, completed_at INTEGER, error TEXT
      );
      CREATE TABLE agent_confirmations (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL,
        details_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT, context_bundle_id TEXT,
        correlation_id TEXT NOT NULL, causation_id TEXT, queued_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE knowledge_objects (
        id TEXT PRIMARY KEY, object_type TEXT NOT NULL, title TEXT NOT NULL,
        authority_level TEXT NOT NULL, status TEXT NOT NULL, document_id TEXT,
        block_id TEXT, source_revision INTEGER, version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE result_verifications (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, summary TEXT NOT NULL,
        verdict TEXT NOT NULL, checks_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY, task_run_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, agent_task_id TEXT, patch_set_task_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, entity_type TEXT NOT NULL,
        approval_kind TEXT NOT NULL DEFAULT 'mutation_approval',
        status TEXT NOT NULL DEFAULT 'pending', decision TEXT NOT NULL,
        request_json TEXT NOT NULL DEFAULT '{}', details_json TEXT NOT NULL,
        run_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
      );
      CREATE TABLE view_snapshots (
        id TEXT PRIMARY KEY, view_id TEXT NOT NULL, source_snapshot_hash TEXT NOT NULL,
        status TEXT NOT NULL, render_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, delegate_type TEXT NOT NULL,
        external_actor_id TEXT NOT NULL, status TEXT NOT NULL, allowed_operations_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL, correlation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE domain_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL, actor_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL, causation_id TEXT, occurred_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL, source TEXT NOT NULL, workspace_id TEXT,
        deduplication_key TEXT, security_scope_json TEXT NOT NULL
      );
      CREATE TABLE outbox_messages (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, topic TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, attempt_count INTEGER NOT NULL, available_at INTEGER NOT NULL,
        last_error TEXT, last_failure_kind TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        published_at INTEGER, dead_lettered_at INTEGER
      );
      CREATE TABLE workflow_wait_conditions (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, deduplication_key TEXT NOT NULL,
        condition_kind TEXT NOT NULL, status TEXT NOT NULL, correlation_id TEXT NOT NULL,
        causation_id TEXT, payload_json TEXT NOT NULL, resume_payload_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, satisfied_at INTEGER
      );
      CREATE TABLE workflow_timers (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, wait_condition_id TEXT NOT NULL,
        due_at INTEGER NOT NULL, available_at INTEGER NOT NULL, status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL, last_error TEXT, fired_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO documents VALUES ('doc-1');
      INSERT INTO agent_tasks VALUES ('agent-1', '总结页面', 'completed', NULL, 50, 80, NULL);
    `)
    repository = new TauriAutomationRepository(client)
  })

  it('persists definitions and queued runs', async () => {
    const created = await repository.createTask({
      id: 'automation-1',
      name: '每日总结',
      instruction: '总结页面',
      triggerType: 'daily',
      triggerConfig: { dailyTime: '09:00' },
      documentId: 'doc-1',
      createdAt: 100,
    })
    expect(created.ok).toBe(true)

    const run: AutomationRun = {
      id: 'run-1',
      automationId: 'automation-1',
      triggerSource: 'manual',
      status: 'queued',
      inputJson: '{}',
      outputJson: null,
      error: null,
      queuedAt: 200,
      startedAt: null,
      completedAt: null,
    }
    expect((await repository.enqueueRun(run, 500)).ok).toBe(true)
    const runs = await repository.listRuns()
    expect(runs.ok && runs.value[0]).toMatchObject({ id: 'run-1', automationName: '每日总结' })
    const tasks = await repository.listTasks()
    expect(tasks.ok && tasks.value[0]).toMatchObject({ lastRunAt: 200, nextRunAt: 500 })
    expect((await repository.enqueueRun({ ...run, id: 'run-2' }, 800)).ok).toBe(false)
  })

  it('combines agent and automation events in the audit feed', async () => {
    await repository.createTask({
      id: 'automation-1',
      name: '每日总结',
      instruction: '总结页面',
      triggerType: 'manual',
      createdAt: 100,
    })
    await repository.enqueueRun(
      {
        id: 'run-1',
        automationId: 'automation-1',
        triggerSource: 'manual',
        status: 'queued',
        inputJson: '{}',
        outputJson: null,
        error: null,
        queuedAt: 200,
        startedAt: null,
        completedAt: null,
      },
      null,
    )

    const audit = await new TauriAuditRepository(client).listEntries()

    expect(audit.ok).toBe(true)
    if (!audit.ok) return
    expect(audit.value.map((entry) => entry.category)).toEqual(['automation_run', 'agent_task'])
    expect(audit.value[0]).toMatchObject({ title: '每日总结', status: 'queued' })

    const filtered = await new TauriAuditRepository(client).listEntries({
      category: 'agent_task',
      search: '总结页面',
      limit: 1,
    })
    expect(filtered.ok && filtered.value).toHaveLength(1)
    expect(filtered.ok && filtered.value[0]).toMatchObject({ category: 'agent_task' })
  })

  it('traces workflow, timer, event and outbox records by correlation id', async () => {
    client.database.exec(`
      INSERT INTO domain_events (
        id, event_type, aggregate_type, aggregate_id, payload_json, actor_id,
        correlation_id, causation_id, occurred_at, schema_version, source,
        workspace_id, deduplication_key, security_scope_json
      ) VALUES (
        'event-1', 'workflow.timer_fired', 'workflow', 'workflow-1', '{}',
        'rust-workflow-timer', 'correlation-trace-1', 'cause-1', 300, 1,
        'rust_timer', NULL, 'timer-1', '{}'
      );
      INSERT INTO outbox_messages (
        id, event_id, topic, payload_json, status, attempt_count, available_at,
        last_error, last_failure_kind, created_at, updated_at, dead_lettered_at
      ) VALUES (
        'outbox-1', 'event-1', 'workflow.timer_fired', '{}', 'dead_lettered', 8, 400,
        'delivery failed', 'retry_exhausted', 310, 400, 400
      );
      INSERT INTO workflow_wait_conditions (
        id, workflow_id, deduplication_key, condition_kind, status, correlation_id,
        causation_id, payload_json, created_at, updated_at, satisfied_at
      ) VALUES (
        'wait-1', 'workflow-1', 'wake', 'timer', 'satisfied',
        'correlation-trace-1', 'cause-1', '{}', 100, 300, 300
      );
      INSERT INTO workflow_timers (
        id, workflow_id, wait_condition_id, due_at, available_at, status,
        attempt_count, last_error, fired_at, created_at, updated_at
      ) VALUES (
        'timer-1', 'workflow-1', 'wait-1', 250, 250, 'fired', 1, NULL, 300, 110, 300
      );
    `)

    const trace = await new TauriAuditRepository(client).listEntries({
      search: 'correlation-trace-1',
    })

    expect(trace.ok).toBe(true)
    if (!trace.ok) return
    expect(trace.value.map((entry) => entry.category)).toEqual([
      'outbox',
      'domain_event',
      'workflow_timer',
      'workflow_wait',
    ])
    expect(trace.value[0]).toMatchObject({ status: 'dead_lettered', severity: 'error' })
  })
})
