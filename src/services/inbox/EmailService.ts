import { invoke } from '@tauri-apps/api/core'

import {
  validateEmailAccountInput,
  type CreateEmailAccountInput,
  type EmailAccount,
  type EmailBlockedSender,
  type EmailConnectionInput,
  type EmailProcessingStatus,
  type EmailSenderBlockResult,
  type RemoteEmailMessage,
} from '@/models/inbox/email'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { EmailRepository } from '@/repositories/inbox/EmailRepository'

export class EmailService {
  constructor(
    private readonly repository: EmailRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  listAccounts() {
    return this.repository.listAccounts()
  }

  listMessages(input: { accountId?: string; status?: EmailProcessingStatus; limit?: number } = {}) {
    return this.repository.listMessages(input)
  }

  async testConnection(input: CreateEmailAccountInput): Promise<AppResult<void>> {
    const invalid = validateEmailAccountInput(input)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    try {
      await invoke('test_email_connection', { input: toConnectionInput(input) })
      return ok(undefined)
    } catch (error) {
      return err(normalizeError(error, '无法连接邮箱。'))
    }
  }

  async createAccount(input: CreateEmailAccountInput): Promise<AppResult<EmailAccount>> {
    const invalid = validateEmailAccountInput(input)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    const tested = await this.testConnection(input)
    if (!tested.ok) return tested

    const createdAt = this.now()
    const account: EmailAccount = {
      id: this.createId('email-account'),
      displayName: input.displayName.trim(),
      emailAddress: input.emailAddress.trim(),
      imapHost: input.imapHost.trim().toLocaleLowerCase(),
      imapPort: input.imapPort,
      username: input.username.trim(),
      mailbox: input.mailbox.trim(),
      authType: 'password',
      sourceCategory: input.sourceCategory.trim(),
      enabled: true,
      lastSyncedAt: null,
      syncCursorAt: null,
      lastRemoteUid: 0,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    }

    try {
      await invoke('set_email_account_secret', {
        input: { accountId: account.id, password: input.password },
      })
    } catch (error) {
      return err(normalizeError(error, '无法安全保存邮箱凭据。'))
    }

    const created = await this.repository.createAccount(account)
    if (created.ok) return created
    await invoke('delete_email_account_secret', { accountId: account.id }).catch(() => undefined)
    return created
  }

  async syncAccount(account: EmailAccount, limit = 25): Promise<AppResult<number>> {
    const syncedAt = this.now()
    try {
      const messages = await invoke<RemoteEmailMessage[]>('sync_email_account', {
        input: {
          accountId: account.id,
          host: account.imapHost,
          port: account.imapPort,
          username: account.username,
          mailbox: account.mailbox,
          afterUid: account.lastRemoteUid || null,
          limit: Math.max(1, Math.min(limit, 50)),
        },
      })
      const stored = await this.repository.upsertMessages(account, messages, syncedAt)
      if (!stored.ok) {
        await this.repository.updateSyncState(account.id, {
          lastSyncedAt: account.lastSyncedAt,
          lastError: stored.error.message,
          updatedAt: syncedAt,
        })
        return stored
      }
      const nextCursor = messages.reduce(
        (latest, message) => Math.max(latest, message.receivedAt),
        account.syncCursorAt ?? 0,
      )
      const nextRemoteUid = messages.reduce(
        (latest, message) => Math.max(latest, message.remoteUid),
        account.lastRemoteUid,
      )
      const syncState = await this.repository.updateSyncState(account.id, {
        lastSyncedAt: syncedAt,
        syncCursorAt: nextCursor || null,
        lastRemoteUid: nextRemoteUid,
        lastError: null,
        updatedAt: syncedAt,
      })
      if (!syncState.ok) return err(syncState.error)
      return stored
    } catch (error) {
      const normalized = normalizeError(error, '邮箱同步失败。')
      await this.repository.updateSyncState(account.id, {
        lastSyncedAt: account.lastSyncedAt,
        lastError: normalized.message,
        updatedAt: syncedAt,
      })
      return err(normalized)
    }
  }

  async deleteAccount(id: string): Promise<AppResult<void>> {
    const removed = await this.repository.deleteAccount(id)
    if (!removed.ok) return removed
    try {
      await invoke('delete_email_account_secret', { accountId: id })
      return removed
    } catch (error) {
      return err(normalizeError(error, '邮箱账户已删除，但安全凭据清理失败。'))
    }
  }

  setMessageStatus(id: string, status: EmailProcessingStatus) {
    return this.repository.setMessageStatus(id, status)
  }

  deleteMessage(id: string) {
    return this.repository.deleteMessage(id)
  }

  listBlockedSenders(accountId?: string) {
    return this.repository.listBlockedSenders(accountId)
  }

  async blockSender(
    accountId: string,
    senderAddress: string,
  ): Promise<AppResult<EmailSenderBlockResult>> {
    const normalized = normalizeSenderAddress(senderAddress)
    if (!normalized)
      return err({ code: 'validation-error', message: '该邮件没有可用于屏蔽的发件地址。' })
    const sender: EmailBlockedSender = {
      accountId,
      senderAddress: normalized,
      createdAt: this.now(),
    }
    const blocked = await this.repository.blockSender(sender)
    return blocked.ok ? ok({ sender, removedCount: blocked.value }) : blocked
  }

  unblockSender(accountId: string, senderAddress: string) {
    const normalized = normalizeSenderAddress(senderAddress)
    if (!normalized)
      return Promise.resolve(
        err({ code: 'validation-error', message: '该屏蔽来源的发件地址无效。' }),
      )
    return this.repository.unblockSender(accountId, normalized)
  }

  updateCategory(id: string, sourceCategory: string) {
    const normalized = sourceCategory.trim()
    if (!normalized || normalized.length > 80)
      return Promise.resolve(
        err({ code: 'validation-error', message: '来源分类不能为空且不能超过 80 个字符。' }),
      )
    return this.repository.updateCategory(id, normalized, this.now())
  }
}

function normalizeSenderAddress(value: string): string {
  const normalized = value.trim().toLocaleLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 320 ? normalized : ''
}

function toConnectionInput(input: CreateEmailAccountInput): EmailConnectionInput {
  return {
    host: input.imapHost.trim().toLocaleLowerCase(),
    port: input.imapPort,
    username: input.username.trim(),
    password: input.password,
    mailbox: input.mailbox.trim(),
  }
}
