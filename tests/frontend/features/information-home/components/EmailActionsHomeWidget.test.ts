import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EmailActionsHomeWidget from '@/features/information-home/components/EmailActionsHomeWidget.vue'
import type { InformationHomeSummary } from '@/models/home/informationHome'
import type { EmailAccount, EmailMessage } from '@/models/inbox/email'
import { ok } from '@/models/shared/result'

const service = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  listMessages: vi.fn(),
  setMessageStatus: vi.fn(),
}))

vi.mock('@/app/composition/emailServiceFactory', () => ({
  createEmailService: vi.fn(async () => service),
}))

describe('EmailActionsHomeWidget', () => {
  beforeEach(() => {
    service.listAccounts.mockResolvedValue(ok([account]))
    service.listMessages.mockResolvedValue(ok([message]))
    service.setMessageStatus.mockResolvedValue(ok({ ...message, processingStatus: 'done' }))
  })

  it('opens the selected message and removes it after processing', async () => {
    const wrapper = mount(EmailActionsHomeWidget, { props: { limit: 8, summaries: [summary] } })
    await flushPromises()

    expect(wrapper.text()).toContain('需要处理的构建告警')
    expect(wrapper.text()).toContain('主分支质量检查未通过')
    expect(wrapper.text()).not.toContain('Quality workflow failed')
    await wrapper.get('button[aria-label="前往处理"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[message.id]])

    await wrapper.get('button[aria-label="标记为已处理"]').trigger('click')
    await flushPromises()
    expect(service.setMessageStatus).toHaveBeenCalledWith(message.id, 'done')
    expect(wrapper.find('.dashboard-widget-list').exists()).toBe(false)
    expect(wrapper.text()).toContain('当前没有待处理邮件')
  })
})

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
  lastRemoteUid: 1,
  lastError: null,
  createdAt: 10,
  updatedAt: 20,
}

const message: EmailMessage = {
  id: 'message-1',
  accountId: account.id,
  mailbox: 'INBOX',
  remoteUid: 1,
  messageId: null,
  subject: 'Quality workflow failed',
  fromName: 'Alice',
  fromAddress: 'alice@example.com',
  toAddresses: ['me@example.com'],
  receivedAt: 20,
  preview: '请确认',
  bodyText: '请确认',
  attachmentCount: 0,
  serverIsRead: false,
  processingStatus: 'pending',
  syncedAt: 20,
}

const summary: InformationHomeSummary = {
  id: 'home-summary-signal-event-1',
  homeId: 'default',
  sourceCursorAt: 20,
  triggerSource: 'auto',
  status: 'completed',
  content: '## 邮件简报\n- [EMAIL:message-1] 需要处理的构建告警 — 主分支质量检查未通过',
  provider: 'test',
  model: 'test',
  error: null,
  generatedAt: 20,
}
