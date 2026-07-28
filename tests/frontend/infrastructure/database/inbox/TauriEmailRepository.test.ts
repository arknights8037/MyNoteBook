import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { TauriEmailRepository } from '@/infrastructure/database/inbox/TauriEmailRepository'
import type { EmailAccount } from '@/models/inbox/email'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/shared/SqlClient'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  async execute(sql: string, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database.prepare(sql).run(...values.map(normalizeValue))
    return { rowsAffected: Number(result.changes) }
  }
  async select<T extends Record<string, unknown>>(
    sql: string,
    values: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...values.map(normalizeValue)) as T[]
  }
}

describe('TauriEmailRepository', () => {
  it('persists account configuration and upserts messages without resetting local processing state', async () => {
    const client = new Client()
    client.database.exec(
      readFileSync(join(process.cwd(), 'src-tauri/migrations/0030_add_email_inbox.sql'), 'utf8'),
    )
    const repository = new TauriEmailRepository(client)
    expect(
      client.database
        .prepare(
          "SELECT count(*) count FROM pragma_table_info('email_accounts') WHERE name LIKE '%password%' OR name LIKE '%secret%'",
        )
        .get(),
    ).toEqual({ count: 0 })
    const account: EmailAccount = {
      id: 'email-account-1',
      displayName: '工作邮箱',
      emailAddress: 'me@example.com',
      imapHost: 'imap.example.com',
      imapPort: 993,
      username: 'me@example.com',
      mailbox: 'INBOX',
      authType: 'password',
      enabled: true,
      lastSyncedAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(await repository.createAccount(account)).toMatchObject({
      ok: true,
      value: { id: account.id },
    })
    const remote = {
      remoteUid: 42,
      messageId: '<message@example.com>',
      subject: '状态更新',
      fromName: 'Alice',
      fromAddress: 'alice@example.com',
      toAddresses: ['me@example.com'],
      receivedAt: 2,
      preview: 'hello',
      bodyText: 'hello inbox',
      attachmentCount: 1,
      serverIsRead: false,
    }
    expect(await repository.upsertMessages(account, [remote], 3)).toEqual({ ok: true, value: 1 })
    const listed = await repository.listMessages({ status: 'pending' })
    expect(listed).toMatchObject({
      ok: true,
      value: [{ remoteUid: 42, processingStatus: 'pending' }],
    })
    if (!listed.ok) throw new Error('expected messages')
    await repository.setMessageStatus(listed.value[0]!.id, 'done')
    await repository.upsertMessages(
      account,
      [{ ...remote, subject: '更新后的主题', serverIsRead: true }],
      4,
    )
    expect(await repository.listMessages()).toMatchObject({
      ok: true,
      value: [{ subject: '更新后的主题', serverIsRead: true, processingStatus: 'done' }],
    })
    await repository.deleteAccount(account.id)
    expect(await repository.listMessages()).toEqual({ ok: true, value: [] })
  })
})

function normalizeValue(value: SqlValue) {
  return typeof value === 'boolean' ? Number(value) : value
}
