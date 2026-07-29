import { describe, expect, it } from 'vitest'

import { validateEmailAccountInput } from '@/models/inbox/email'

describe('email connector model', () => {
  const valid = {
    displayName: '工作邮箱',
    emailAddress: 'me@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    username: 'me@example.com',
    mailbox: 'INBOX',
    password: 'app-password',
    sourceCategory: '工作',
  }

  it('accepts a constrained TLS IMAP account', () => {
    expect(validateEmailAccountInput(valid)).toBeNull()
  })

  it('rejects credentialed hosts and invalid ports', () => {
    expect(validateEmailAccountInput({ ...valid, imapHost: 'user:pass@example.com' })).toContain(
      '主机名',
    )
    expect(validateEmailAccountInput({ ...valid, imapPort: 70_000 })).toContain('端口')
  })
})
