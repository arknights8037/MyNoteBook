import type {
  EmailAccount,
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
  enabled: number
  last_synced_at: number | null
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
      await this.sql.execute(
        `INSERT INTO email_accounts (
          id, display_name, email_address, imap_host, imap_port, username, mailbox,
          auth_type, enabled, last_synced_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'password', 1, NULL, NULL, ?, ?)`,
        [
          account.id,
          account.displayName,
          account.emailAddress,
          account.imapHost,
          account.imapPort,
          account.username,
          account.mailbox,
          account.createdAt,
          account.updatedAt,
        ],
      )
      return this.getAccount(account.id)
    } catch (error) {
      return err(normalizeError(error, '无法保存邮箱账户。'))
    }
  }

  async deleteAccount(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.execute('DELETE FROM email_accounts WHERE id = ?', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '邮箱账户不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除邮箱账户。'))
    }
  }

  async updateSyncState(
    id: string,
    state: { lastSyncedAt: number | null; lastError: string | null; updatedAt: number },
  ): Promise<AppResult<EmailAccount>> {
    try {
      await this.sql.execute(
        'UPDATE email_accounts SET last_synced_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
        [state.lastSyncedAt, state.lastError, state.updatedAt, id],
      )
      return this.getAccount(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新邮箱同步状态。'))
    }
  }

  async upsertMessages(
    account: EmailAccount,
    messages: RemoteEmailMessage[],
    syncedAt: number,
  ): Promise<AppResult<number>> {
    try {
      for (const message of messages) {
        await this.sql.execute(
          `INSERT INTO email_messages (
            id, account_id, mailbox, remote_uid, message_id, subject, from_name, from_address,
            to_json, received_at, preview, body_text, attachment_count, server_is_read, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, mailbox, remote_uid) DO UPDATE SET
            message_id = excluded.message_id,
            subject = excluded.subject,
            from_name = excluded.from_name,
            from_address = excluded.from_address,
            to_json = excluded.to_json,
            received_at = excluded.received_at,
            preview = excluded.preview,
            body_text = excluded.body_text,
            attachment_count = excluded.attachment_count,
            server_is_read = excluded.server_is_read,
            synced_at = excluded.synced_at`,
          [
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
            message.serverIsRead,
            syncedAt,
          ],
        )
      }
      return ok(messages.length)
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
      const result = await this.sql.execute(
        'UPDATE email_messages SET processing_status = ? WHERE id = ?',
        [status, id],
      )
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
    enabled: Boolean(row.enabled),
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
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
