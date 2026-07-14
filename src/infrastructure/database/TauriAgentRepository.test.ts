import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

import { TauriAgentRepository } from './TauriAgentRepository'
import type { SqlClient, SqlExecuteResult } from '@/repositories/SqlClient'
import type { SqlValue } from '@/repositories/SqlClient'

class RecoverySqlClient implements SqlClient {
  readonly executedSql: string[] = []

  async execute(sql: string): Promise<SqlExecuteResult> {
    this.executedSql.push(sql)
    return { rowsAffected: 1 }
  }

  async select<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    if (sql.includes('FROM agent_tasks')) {
      return [
        {
          id: 'task-1',
          session_id: 'doc-1',
          status: 'waiting_confirmation',
          user_instruction: '更新内容',
          context_scope: 'current_document',
          model: 'test-model',
          current_step: '等待用户确认修改',
          error: null,
          created_at: 10,
          completed_at: null,
        } as T,
      ]
    }
    if (sql.includes('FROM agent_patch_sets')) {
      return [{ task_id: 'task-1', model: 'test-model', created_at: 11 } as T]
    }
    if (sql.includes('FROM agent_patches')) {
      return [
        {
          id: 'patch-1',
          task_id: 'task-1',
          operation: 'replace',
          document_id: 'doc-1',
          block_id: 'block-1',
          target_block_ids_json: '["block-1"]',
          expected_version: 3,
          before_text: '修改前',
          after_text: '修改后',
          reason: '补充说明',
          status: 'proposed',
          document_title: null,
          parent_document_id: null,
        } as T,
      ]
    }
    if (sql.includes('FROM agent_task_sources')) {
      return [
        {
          document_id: 'source-1',
          document_title: '参考资料',
          block_ids_json: '["source-block"]',
        } as T,
      ]
    }
    if (sql.includes('FROM (')) {
      return [
        {
          id: 'transaction-1',
          task_id: 'task-1',
          document_id: 'doc-1',
          before_revision: 3,
          resulting_revision: 4,
          status: 'applied',
          created_at: 12,
          rolled_back_at: null,
        } as T,
      ]
    }
    return []
  }
}

class SqliteRecoveryClient implements SqlClient {
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

describe('TauriAgentRepository recovery', () => {
  it('maps persisted tasks, patches, sources and the latest safe transaction', async () => {
    const repository = new TauriAgentRepository(new RecoverySqlClient())

    const recovered = await repository.loadRecoveryState('doc-1')

    expect(recovered.ok).toBe(true)
    if (!recovered.ok) return
    expect(recovered.value.pendingTask).toMatchObject({
      id: 'task-1',
      status: 'waiting_confirmation',
    })
    expect(recovered.value.pendingPatchSet?.patches[0]).toMatchObject({
      patchId: 'patch-1',
      targetBlockIds: ['block-1'],
      accepted: true,
    })
    expect(recovered.value.pendingPatchSet?.contextSources[0]).toMatchObject({
      documentId: 'source-1',
      blockIds: ['source-block'],
    })
    expect(recovered.value.lastAppliedTransaction).toMatchObject({
      id: 'transaction-1',
      resultingRevision: 4,
    })
  })

  it('marks unfinished tasks as interrupted only when startup recovery requests it', async () => {
    const sqlClient = new RecoverySqlClient()
    const repository = new TauriAgentRepository(sqlClient)

    await repository.loadRecoveryState('doc-1', { markInterrupted: true })

    expect(sqlClient.executedSql.join('\n')).toContain("status = 'failed'")
    expect(sqlClient.executedSql.join('\n')).toContain("status IN ('pending', 'running')")
  })

  it('executes the recovery query against SQLite and hides stale transactions', async () => {
    const sqlClient = new SqliteRecoveryClient()
    sqlClient.database.exec(`
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, document_id TEXT NOT NULL,
        status TEXT NOT NULL, user_instruction TEXT NOT NULL, context_scope TEXT NOT NULL,
        model TEXT NOT NULL, current_step TEXT NOT NULL, error TEXT,
        created_at INTEGER NOT NULL, completed_at INTEGER,
        correlation_id TEXT, causation_id TEXT, execution_policy_json TEXT NOT NULL DEFAULT '{}',
        context_bundle_id TEXT, provider TEXT, task_run_id TEXT
      );
      CREATE TABLE agent_patch_sets (task_id TEXT PRIMARY KEY, model TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE agent_patches (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, operation TEXT NOT NULL,
        document_id TEXT NOT NULL, block_id TEXT NOT NULL, target_block_ids_json TEXT NOT NULL,
        expected_version INTEGER NOT NULL, before_text TEXT NOT NULL, after_text TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, document_title TEXT, parent_document_id TEXT
      );
      CREATE TABLE agent_task_sources (
        task_id TEXT NOT NULL, document_id TEXT NOT NULL, document_title TEXT NOT NULL,
        block_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE documents (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, is_deleted INTEGER NOT NULL);
      CREATE TABLE agent_document_transactions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, document_id TEXT NOT NULL,
        before_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, rolled_back_at INTEGER
      );
      CREATE TABLE agent_document_creation_transactions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, document_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, rolled_back_at INTEGER
      );
      INSERT INTO agent_tasks (
        id, session_id, document_id, status, user_instruction, context_scope,
        model, current_step, error, created_at, completed_at
      ) VALUES
        ('task-1', 'doc-1', 'doc-1', 'completed', '修改正文', 'current_document',
         'test-model', '修改已写入文档', NULL, 10, 20);
      INSERT INTO agent_patch_sets VALUES ('task-1', 'test-model', 11);
      INSERT INTO agent_patches VALUES
        ('patch-1', 'task-1', 'replace', 'doc-1', 'block-1', '["block-1"]',
         3, '修改前', '修改后', '测试', 'accepted', 11, 20, NULL, NULL);
      INSERT INTO documents VALUES ('doc-1', 4, 0);
      INSERT INTO agent_document_transactions VALUES
        ('transaction-1', 'task-1', 'doc-1', 3, 4, 'applied', 20, NULL);
    `)
    const repository = new TauriAgentRepository(sqlClient)

    const recovered = await repository.loadRecoveryState('doc-1')

    expect(recovered.ok).toBe(true)
    if (!recovered.ok) return
    expect(recovered.value.lastAppliedTransaction?.id).toBe('transaction-1')

    sqlClient.database.prepare('UPDATE documents SET revision = 5 WHERE id = ?').run('doc-1')
    const stale = await repository.loadRecoveryState('doc-1')
    expect(stale.ok && stale.value.lastAppliedTransaction).toBeNull()
  })
})
