import type {
  EmailAccount,
  EmailBlockedSender,
  EmailMessage,
  EmailProcessingStatus,
  RemoteEmailMessage,
} from '@/models/inbox/email'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { EmailRepository } from '@/repositories/inbox/EmailRepository'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import { parseJsonStrict } from '@/repositories/shared/jsonCodec'

interface EmailAccountRow extends Record<string, unknown> {
  id: string
  display_name: string
  email_address: string
  imap_host: string
  imap_port: number
  username: string
  mailbox: string
  auth_type: string
  source_category: string
  enabled: number
  last_synced_at: number | null
  sync_cursor_at: number | null
  last_remote_uid: number
  last_error: string | null
  created_at: number
  updated_at: number
}

interface EmailMessageRow extends Record<string, unknown> {
  id: string
  account_id: string
  mailbox: string
  remote_uid: number
  message_id: string | null
  subject: string
  from_name: string
  from_address: string
  to_json: string
  received_at: number
  preview: string
  body_text: string
  attachment_count: number
  server_is_read: number
  processing_status: EmailProcessingStatus
  synced_at: number
}

interface EmailBlockedSenderRow extends Record<string, unknown> {
  account_id: string
  sender_address: string
  created_at: number
}

export class TauriEmailRepository implements EmailRepository {
  constructor(private readonly sql: SqlClient) {}

  async listAccounts(): Promise<AppResult<EmailAccount[]>> {
    try {
      const rows = await this.sql.select<EmailAccountRow>(
        'SELECT * FROM email_accounts ORDER BY enabled DESC, updated_at DESC, id ASC',
      )
      return ok(rows.map(mapAccount))
    } catch (error) {
      return err(normalizeError(error, '无法读取邮箱账户。'))
    }
  }

  async getAccount(id: string): Promise<AppResult<EmailAccount>> {
    try {
      const rows = await this.sql.select<EmailAccountRow>(
        'SELECT * FROM email_accounts WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapAccount(rows[0]))
        : err({ code: 'not-found', message: '邮箱账户不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取邮箱账户。'))
    }
  }

  async createAccount(account: EmailAccount): Promise<AppResult<EmailAccount>> {
    try {
      await this.sql.mutate('createEmailAccount', [
        account.id,
        account.displayName,
        account.emailAddress,
        account.imapHost,
        account.imapPort,
        account.username,
        account.mailbox,
        account.sourceCategory,
        account.createdAt,
        account.updatedAt,
      ])
      return this.getAccount(account.id)
    } catch (error) {
      return err(normalizeError(error, '无法保存邮箱账户。'))
    }
  }

  async deleteAccount(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.mutate('deleteEmailAccount', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '邮箱账户不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除邮箱账户。'))
    }
  }

  async updateSyncState(
    id: string,
    state: {
      lastSyncedAt: number | null
      syncCursorAt?: number | null
      lastRemoteUid?: number
      lastError: string | null
      updatedAt: number
    },
  ): Promise<AppResult<EmailAccount>> {
    try {
      await this.sql.mutate('updateEmailSyncState', [
        state.lastSyncedAt,
        state.syncCursorAt ?? null,
        state.lastRemoteUid ?? null,
        state.lastError,
        state.updatedAt,
        id,
      ])
      return this.getAccount(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新邮箱同步状态。'))
    }
  }

  async updateCategory(
    id: string,
    sourceCategory: string,
    updatedAt: number,
  ): Promise<AppResult<EmailAccount>> {
    try {
      const result = await this.sql.mutate('updateEmailCategory', [sourceCategory, updatedAt, id])
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: '邮箱账户不存在。' })
      return this.getAccount(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新邮箱来源分类。'))
    }
  }

  async upsertMessages(
    account: EmailAccount,
    messages: RemoteEmailMessage[],
    syncedAt: number,
  ): Promise<AppResult<number>> {
    try {
      const blocked = await this.listBlockedSenders(account.id)
      if (!blocked.ok) return blocked
      const blockedAddresses = new Set(blocked.value.map((sender) => sender.senderAddress))
      const acceptedMessages = messages.filter(
        (message) => !blockedAddresses.has(message.fromAddress.trim().toLocaleLowerCase()),
      )
      for (const message of acceptedMessages) {
        await this.sql.mutate('upsertEmailMessage', [
          `${account.id}:${account.mailbox}:${message.remoteUid}`,
          account.id,
          account.mailbox,
          message.remoteUid,
          message.messageId,
          message.subject,
          message.fromName,
          message.fromAddress,
          JSON.stringify(message.toAddresses),
          message.receivedAt,
          message.preview,
          message.bodyText,
          message.attachmentCount,
          message.serverIsRead ? 1 : 0,
          syncedAt,
        ])
      }
      return ok(acceptedMessages.length)
    } catch (error) {
      return err(normalizeError(error, '无法保存同步邮件。'))
    }
  }

  async listMessages(
    input: {
      accountId?: string
      status?: EmailProcessingStatus
      limit?: number
    } = {},
  ): Promise<AppResult<EmailMessage[]>> {
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (input.accountId) {
      conditions.push('account_id = ?')
      values.push(input.accountId)
    }
    if (input.status) {
      conditions.push('processing_status = ?')
      values.push(input.status)
    }
    values.push(Math.max(1, Math.min(input.limit ?? 100, 500)))
    try {
      const rows = await this.sql.select<EmailMessageRow>(
        `SELECT * FROM email_messages ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY received_at DESC, id ASC LIMIT ?`,
        values,
      )
      return ok(rows.map(mapMessage))
    } catch (error) {
      return err(normalizeError(error, '无法读取收件箱邮件。'))
    }
  }

  async setMessageStatus(
    id: string,
    status: EmailProcessingStatus,
  ): Promise<AppResult<EmailMessage>> {
    try {
      const result = await this.sql.mutate('setEmailMessageStatus', [status, id])
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: '邮件不存在。' })
      const rows = await this.sql.select<EmailMessageRow>(
        'SELECT * FROM email_messages WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0] ? ok(mapMessage(rows[0])) : err({ code: 'not-found', message: '邮件不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法更新邮件处理状态。'))
    }
  }

  async deleteMessage(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.mutate('deleteEmailMessage', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '邮件不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除本地邮件。'))
    }
  }

  async listBlockedSenders(accountId?: string): Promise<AppResult<EmailBlockedSender[]>> {
    try {
      const rows = await this.sql.select<EmailBlockedSenderRow>(
        `SELECT * FROM email_blocked_senders ${accountId ? 'WHERE account_id = ?' : ''}
         ORDER BY created_at DESC, sender_address ASC`,
        accountId ? [accountId] : [],
      )
      return ok(
        rows.map((row) => ({
          accountId: row.account_id,
          senderAddress: row.sender_address,
          createdAt: Number(row.created_at),
        })),
      )
    } catch (error) {
      return err(normalizeError(error, '无法读取邮件屏蔽列表。'))
    }
  }

  async blockSender(sender: EmailBlockedSender): Promise<AppResult<number>> {
    try {
      const rows = await this.sql.select<{ count: number }>(
        'SELECT COUNT(*) count FROM email_messages WHERE account_id = ? AND from_address = ? COLLATE NOCASE',
        [sender.accountId, sender.senderAddress],
      )
      await this.sql.mutate('blockEmailSender', [
        sender.accountId,
        sender.senderAddress,
        sender.createdAt,
      ])
      return ok(Number(rows[0]?.count ?? 0))
    } catch (error) {
      return err(normalizeError(error, '无法屏蔽邮件来源。'))
    }
  }

  async unblockSender(accountId: string, senderAddress: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.mutate('unblockEmailSender', [accountId, senderAddress])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '该邮件来源不在屏蔽列表中。' })
    } catch (error) {
      return err(normalizeError(error, '无法解除邮件来源屏蔽。'))
    }
  }
}

function mapAccount(row: EmailAccountRow): EmailAccount {
  return {
    id: row.id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    imapHost: row.imap_host,
    imapPort: Number(row.imap_port),
    username: row.username,
    mailbox: row.mailbox,
    authType: 'password',
    sourceCategory: row.source_category,
    enabled: Boolean(row.enabled),
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
    syncCursorAt: row.sync_cursor_at == null ? null : Number(row.sync_cursor_at),
    lastRemoteUid: Number(row.last_remote_uid),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapMessage(row: EmailMessageRow): EmailMessage {
  const recipients = parseJsonStrict<unknown>(row.to_json, '邮件收件人')
  return {
    id: row.id,
    accountId: row.account_id,
    mailbox: row.mailbox,
    remoteUid: Number(row.remote_uid),
    messageId: row.message_id,
    subject: row.subject,
    fromName: row.from_name,
    fromAddress: row.from_address,
    toAddresses: Array.isArray(recipients)
      ? recipients.filter((value): value is string => typeof value === 'string')
      : [],
    receivedAt: Number(row.received_at),
    preview: row.preview,
    bodyText: row.body_text,
    attachmentCount: Number(row.attachment_count),
    serverIsRead: Boolean(row.server_is_read),
    processingStatus: row.processing_status,
    syncedAt: Number(row.synced_at),
  }
}
