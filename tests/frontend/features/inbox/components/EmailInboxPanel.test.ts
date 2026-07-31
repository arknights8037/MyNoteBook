import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EmailAccount, EmailBlockedSender, EmailMessage } from '@/models/inbox/email'
import { ok } from '@/models/shared/result'

const service = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listMessages: vi.fn(),
  listBlockedSenders: vi.fn(),
  setMessageStatus: vi.fn(),
  deleteMessage: vi.fn(),
  blockSender: vi.fn(),
  unblockSender: vi.fn(),
}))
const notify = vi.hoisted(() => ({ success: vi.fn() }))

vi.mock('@/app/composition/emailServiceFactory', () => ({
  createEmailService: vi.fn(async () => service),
}))
vi.mock('@/ui/services', () => ({
  useMessage: () => notify,
}))

describe('EmailInboxPanel', () => {
  beforeEach(() => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    service.listAccounts.mockResolvedValue(ok([account]))
    service.listMessages.mockResolvedValue(ok(messages))
    service.listBlockedSenders.mockResolvedValue(ok([]))
    service.setMessageStatus.mockImplementation(async (id: string, status: string) =>
      ok({ ...messages.find((message) => message.id === id)!, processingStatus: status }),
    )
    service.deleteMessage.mockResolvedValue(ok(undefined))
    service.blockSender.mockResolvedValue(ok({ sender: blockedSender, removedCount: 1 }))
    service.unblockSender.mockResolvedValue(ok(undefined))
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__')
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('persists ignore, delete and sender blocking before updating the control page', async () => {
    const { default: EmailInboxPanel } =
      await import('@/features/inbox/components/EmailInboxPanel.vue')
    const wrapper = mount(EmailInboxPanel, { props: { mode: 'email' } })
    await flushPromises()

    await findButton(wrapper, '忽略').trigger('click')
    await flushPromises()
    expect(service.setMessageStatus).toHaveBeenCalledWith('message-1', 'archived')
    expect(wrapper.text()).toContain('已忽略')

    await findButton(wrapper, '删除本地').trigger('click')
    await flushPromises()
    expect(service.deleteMessage).toHaveBeenCalledWith('message-1')
    expect(wrapper.text()).not.toContain('第一封邮件')
    expect(wrapper.text()).toContain('第二封邮件')

    await findButton(wrapper, '屏蔽来源').trigger('click')
    await flushPromises()
    expect(service.blockSender).toHaveBeenCalledWith(account.id, 'blocked@example.com')
    expect(wrapper.text()).not.toContain('第二封邮件')

    await findButton(wrapper, '屏蔽列表').trigger('click')
    expect(wrapper.text()).toContain('blocked@example.com')
    await findButton(wrapper, '解除屏蔽').trigger('click')
    await flushPromises()
    expect(service.unblockSender).toHaveBeenCalledWith(account.id, 'blocked@example.com')
    expect(wrapper.text()).not.toContain('blocked@example.com')
  })
})

function findButton(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().includes(label))
  if (!button) throw new Error(`missing button: ${label}`)
  return button
}

const account: EmailAccount = {
  id: 'account-1',
  displayName: '工作邮箱',
  emailAddress: 'me@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  username: 'me@example.com',
  mailbox: 'INBOX',
  authType: 'password',
  sourceCategory: '工作',
  enabled: true,
  lastSyncedAt: 20,
  syncCursorAt: 20,
  lastRemoteUid: 2,
  lastError: null,
  createdAt: 10,
  updatedAt: 20,
}

const messages: EmailMessage[] = [
  {
    id: 'message-1',
    accountId: account.id,
    mailbox: 'INBOX',
    remoteUid: 1,
    messageId: null,
    subject: '第一封邮件',
    fromName: 'Alice',
    fromAddress: 'alice@example.com',
    toAddresses: ['me@example.com'],
    receivedAt: 20,
    preview: '第一封预览',
    bodyText: '第一封正文',
    attachmentCount: 0,
    serverIsRead: false,
    processingStatus: 'pending',
    syncedAt: 20,
  },
  {
    id: 'message-2',
    accountId: account.id,
    mailbox: 'INBOX',
    remoteUid: 2,
    messageId: null,
    subject: '第二封邮件',
    fromName: 'Blocked',
    fromAddress: 'blocked@example.com',
    toAddresses: ['me@example.com'],
    receivedAt: 10,
    preview: '第二封预览',
    bodyText: '第二封正文',
    attachmentCount: 0,
    serverIsRead: true,
    processingStatus: 'pending',
    syncedAt: 20,
  },
]

const blockedSender: EmailBlockedSender = {
  accountId: account.id,
  senderAddress: 'blocked@example.com',
  createdAt: 30,
}
