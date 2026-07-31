import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { TauriEmailRepository } from '@/infrastructure/database/inbox/TauriEmailRepository'
import type { EmailAccount } from '@/models/inbox/email'
import type {
  DatabaseMutation,
  SqlClient,
  SqlExecuteResult,
  SqlValue,
} from '@/repositories/shared/SqlClient'
import { testDatabaseMutationSql } from '../testDatabaseMutations'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  rawExecuteValues: SqlValue[][] = []
  async mutate(mutation: DatabaseMutation, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    this.rawExecuteValues.push(values)
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

describe('TauriEmailRepository', () => {
  it('persists account configuration and upserts messages without resetting local processing state', async () => {
    const client = new Client()
    client.database.exec(
      readFileSync(join(process.cwd(), 'src-tauri/migrations/0030_add_email_inbox.sql'), 'utf8'),
    )
    client.database.exec(
      readFileSync(join(process.cwd(), 'src-tauri/migrations/0031_add_rss_inbox.sql'), 'utf8'),
    )
    client.database.exec(
      readFileSync(
        join(process.cwd(), 'src-tauri/migrations/0032_add_rss_article_extraction.sql'),
        'utf8',
      ),
    )
    client.database.exec(
      readFileSync(
        join(process.cwd(), 'src-tauri/migrations/0033_add_inbox_source_cursors.sql'),
        'utf8',
      ),
    )
    client.database.exec(
      readFileSync(
        join(process.cwd(), 'src-tauri/migrations/0044_add_email_sender_blocks.sql'),
        'utf8',
      ),
    )
    client.database.exec(
      readFileSync(
        join(
          process.cwd(),
          'src-tauri/migrations/0045_cleanup_messages_after_email_sender_block.sql',
        ),
        'utf8',
      ),
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
      sourceCategory: '工作',
      enabled: true,
      lastSyncedAt: null,
      syncCursorAt: null,
      lastRemoteUid: 0,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(await repository.createAccount(account)).toMatchObject({
      ok: true,
      value: { id: account.id },
    })
    expect(await repository.updateCategory(account.id, '个人', 2)).toMatchObject({
      ok: true,
      value: { sourceCategory: '个人' },
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
    expect(client.rawExecuteValues.flat().some((value) => typeof value === 'boolean')).toBe(false)
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
    expect(
      await repository.updateSyncState(account.id, {
        lastSyncedAt: 5,
        syncCursorAt: 2,
        lastRemoteUid: 42,
        lastError: null,
        updatedAt: 5,
      }),
    ).toMatchObject({
      ok: true,
      value: { lastSyncedAt: 5, syncCursorAt: 2, lastRemoteUid: 42 },
    })
    expect(
      await repository.blockSender({
        accountId: account.id,
        senderAddress: 'alice@example.com',
        createdAt: 6,
      }),
    ).toEqual({ ok: true, value: 1 })
    expect(await repository.listBlockedSenders()).toMatchObject({
      ok: true,
      value: [{ accountId: account.id, senderAddress: 'alice@example.com' }],
    })
    expect(await repository.upsertMessages(account, [remote], 7)).toEqual({ ok: true, value: 0 })
    expect(await repository.listMessages()).toEqual({ ok: true, value: [] })
    expect(await repository.unblockSender(account.id, 'alice@example.com')).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await repository.upsertMessages(account, [remote], 8)).toEqual({ ok: true, value: 1 })
    const restored = await repository.listMessages()
    if (!restored.ok) throw new Error('expected restored message')
    expect(await repository.deleteMessage(restored.value[0]!.id)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await repository.listMessages()).toEqual({ ok: true, value: [] })
    await repository.deleteAccount(account.id)
    expect(await repository.listMessages()).toEqual({ ok: true, value: [] })
  })
})

function normalizeValue(value: SqlValue) {
  return typeof value === 'boolean' ? Number(value) : value
}
