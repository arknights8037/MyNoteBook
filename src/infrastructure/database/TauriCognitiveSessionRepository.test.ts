import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/SqlClient'
import { CognitiveSessionService } from '@/services/CognitiveSessionService'
import { TauriCognitiveSessionRepository } from './TauriCognitiveSessionRepository'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  async execute(sql: string, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database.prepare(sql).run(...values)
    return { rowsAffected: Number(result.changes) }
  }
  async select<T extends Record<string, unknown>>(
    sql: string,
    values: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...values) as T[]
  }
}

describe('TauriCognitiveSessionRepository', () => {
  it('persists waiting state, resumes it and rejects stale versions', async () => {
    const client = new Client()
    client.database.exec(`CREATE TABLE cognitive_sessions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, mode_id TEXT NOT NULL,
      mode_version INTEGER NOT NULL, template_id TEXT, template_version INTEGER,
      skill_ids_json TEXT NOT NULL, target_document_ids_json TEXT NOT NULL,
      target_block_ids_json TEXT NOT NULL, state_json TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    const service = new CognitiveSessionService(new TauriCognitiveSessionRepository(client))
    const started = await service.start({
      id: 'session-1',
      conversationId: 'conversation-1',
      modeId: 'learning',
      modeVersion: 1,
      templateId: 'default-cognitive-control',
      templateVersion: 1,
      skillIds: [],
      targetDocumentIds: ['doc-1'],
      targetBlockIds: [],
      state: { question: '解释概念' },
      createdAt: 1,
    })
    expect(started.ok).toBe(true)
    const waiting = await service.waitForUser('session-1', 1, { attempt: 1 })
    expect(waiting).toMatchObject({ ok: true, value: { status: 'waiting_user', version: 2 } })
    const stale = await service.resume('session-1', 1)
    expect(stale).toMatchObject({ ok: false, error: { code: 'revision-conflict' } })
    const resumed = await service.resume('session-1', 2)
    expect(resumed).toMatchObject({ ok: true, value: { status: 'active', state: { attempt: 1 } } })
  })
})
