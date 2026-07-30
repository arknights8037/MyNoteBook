import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { TauriImRepository } from '@/infrastructure/database/inbox/TauriImRepository'
import type { ImConnector } from '@/models/inbox/im'
import type {
  DatabaseMutation,
  SqlClient,
  SqlExecuteResult,
  SqlValue,
} from '@/repositories/shared/SqlClient'
import { testDatabaseMutationSql } from '../testDatabaseMutations'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  async mutate(mutation: DatabaseMutation, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database
      .prepare(testDatabaseMutationSql(mutation))
      .run(...values.map(normalizeValue))
    return { rowsAffected: Number(result.changes) }
  }
  async select<T extends Record<string, unknown>>(
    sql: string,
    values: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...values.map(normalizeValue)) as T[]
  }
}

describe('TauriImRepository', () => {
  it('keeps credentials out of SQLite and cascades conversations and messages', async () => {
    const client = new Client()
    client.database.exec(
      readFileSync(join(process.cwd(), 'src-tauri/migrations/0034_add_dingtalk_inbox.sql'), 'utf8'),
    )
    const repository = new TauriImRepository(client)
    const connector: ImConnector = {
      id: 'im-connector-1',
      provider: 'dingtalk',
      displayName: '研发钉钉',
      sourceCategory: '工作消息',
      clientId: 'ding-client-id',
      enabled: true,
      runtimeStatus: 'stopped',
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(await repository.createConnector(connector)).toMatchObject({
      ok: true,
      value: { id: connector.id, clientId: 'ding-client-id' },
    })
    expect(
      client.database
        .prepare(
          "SELECT count(*) count FROM pragma_table_info('im_connectors') WHERE name LIKE '%secret%' OR name LIKE '%password%'",
        )
        .get(),
    ).toEqual({ count: 0 })

    client.database
      .prepare(
        `INSERT INTO im_conversations
         (id, connector_id, remote_conversation_id, conversation_type, title, created_at, updated_at)
         VALUES (?, ?, ?, 'group', ?, 2, 2)`,
      )
      .run('conversation-1', connector.id, 'remote-conversation', '项目群')
    client.database
      .prepare(
        `INSERT INTO im_messages
         (id, connector_id, conversation_id, remote_message_id, sender_id, sender_name,
          sent_at, received_at, message_type, body_text, attachment_count, processing_status)
         VALUES (?, ?, ?, ?, ?, ?, 3, 3, 'text', ?, 0, 'pending')`,
      )
      .run(
        'message-1',
        connector.id,
        'conversation-1',
        'remote-message',
        'user-1',
        'Alice',
        '进度如何？',
      )

    expect(await repository.listMessages({ status: 'pending' })).toMatchObject({
      ok: true,
      value: [
        {
          conversationTitle: '项目群',
          conversationType: 'group',
          bodyText: '进度如何？',
          processingStatus: 'pending',
        },
      ],
    })
    expect(await repository.setMessageStatus('message-1', 'done')).toMatchObject({
      ok: true,
      value: { processingStatus: 'done' },
    })
    expect(await repository.deleteConnector(connector.id)).toEqual({ ok: true, value: undefined })
    expect(await repository.listMessages()).toEqual({ ok: true, value: [] })
  })
})

function normalizeValue(value: SqlValue) {
  return typeof value === 'boolean' ? Number(value) : value
}
