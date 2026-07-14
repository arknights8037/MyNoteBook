import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'

import { TauriAuditRepository } from './TauriAuditRepository'
import { TauriAutomationRepository } from './TauriAutomationRepository'
import type { AutomationRun } from '@/models/automation'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/SqlClient'

class SqliteClient implements SqlClient {
  readonly database = new DatabaseSync(':memory:')

  async execute(sql: string, bindValues: SqlValue[] = []): Promise<SqlExecuteResult> {
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
        correlation_id TEXT, causation_id TEXT
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
        error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
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
        decision TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL
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
        aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL
      );
      CREATE TABLE outbox_messages (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, topic TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, published_at INTEGER
      );
      INSERT INTO documents VALUES ('doc-1');
      INSERT INTO agent_tasks VALUES ('agent-1', '总结页面', 'completed', NULL, 50, 80);
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
  })
})
