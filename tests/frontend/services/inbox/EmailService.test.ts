import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EmailService } from '@/services/inbox/EmailService'
import { err, ok } from '@/models/shared/result'
import type { EmailRepository } from '@/repositories/inbox/EmailRepository'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('EmailService', () => {
  beforeEach(() => invoke.mockReset())

  it('tests the connection before storing the encrypted credential and account', async () => {
    const repository = createRepository()
    invoke.mockResolvedValue(undefined)
    const service = new EmailService(
      repository,
      () => 'email-account-1',
      () => 10,
    )

    const result = await service.createAccount(validInput())

    expect(result).toMatchObject({ ok: true, value: { id: 'email-account-1' } })
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'test_email_connection',
      'set_email_account_secret',
    ])
    expect(repository.createAccount).toHaveBeenCalledOnce()
  })

  it('syncs remote messages into the repository and records success', async () => {
    const repository = createRepository()
    const account = accountValue()
    invoke.mockResolvedValue([{ remoteUid: 1, subject: 'Hello' }])
    const service = new EmailService(
      repository,
      () => 'unused',
      () => 20,
    )

    const result = await service.syncAccount(account)

    expect(result).toEqual({ ok: true, value: 1 })
    expect(invoke).toHaveBeenCalledWith(
      'sync_email_account',
      expect.objectContaining({
        input: expect.objectContaining({ accountId: account.id, limit: 25 }),
      }),
    )
    expect(repository.updateSyncState).toHaveBeenCalledWith(account.id, {
      lastSyncedAt: 20,
      lastError: null,
      updatedAt: 20,
    })
  })

  it('records a local persistence failure as the account sync error', async () => {
    const repository = createRepository()
    const account = accountValue()
    invoke.mockResolvedValue([{ remoteUid: 1, subject: 'Hello' }])
    repository.upsertMessages.mockResolvedValue(
      err({ code: 'database-error', message: '无法保存同步邮件。' }),
    )
    const service = new EmailService(
      repository,
      () => 'unused',
      () => 30,
    )

    const result = await service.syncAccount(account)

    expect(result).toEqual({
      ok: false,
      error: { code: 'database-error', message: '无法保存同步邮件。' },
    })
    expect(repository.updateSyncState).toHaveBeenCalledWith(account.id, {
      lastSyncedAt: null,
      lastError: '无法保存同步邮件。',
      updatedAt: 30,
    })
  })
})

function createRepository() {
  return {
    listAccounts: vi.fn(async () => ok([])),
    getAccount: vi.fn(async () => ok(accountValue())),
    createAccount: vi.fn(async (account) => ok(account)),
    deleteAccount: vi.fn(async () => ok(undefined)),
    updateSyncState: vi.fn(async () => ok(accountValue())),
    upsertMessages: vi.fn(async (_account, messages) => ok(messages.length)),
    listMessages: vi.fn(async () => ok([])),
    setMessageStatus: vi.fn(),
  } satisfies EmailRepository
}

function validInput() {
  return {
    displayName: '工作邮箱',
    emailAddress: 'me@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    username: 'me@example.com',
    mailbox: 'INBOX',
    password: 'app-password',
  }
}

function accountValue() {
  return {
    id: 'email-account-1',
    displayName: '工作邮箱',
    emailAddress: 'me@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    username: 'me@example.com',
    mailbox: 'INBOX',
    authType: 'password' as const,
    enabled: true,
    lastSyncedAt: null,
    lastError: null,
    createdAt: 10,
    updatedAt: 10,
  }
}
