import { describe, expect, it } from 'vitest'

import { validateDingTalkConnectorInput } from '@/models/inbox/im'

describe('validateDingTalkConnectorInput', () => {
  it('accepts a complete enterprise bot credential form', () => {
    expect(
      validateDingTalkConnectorInput({
        displayName: '研发钉钉',
        sourceCategory: '工作消息',
        clientId: 'ding-client-id',
        clientSecret: 'secret-value',
      }),
    ).toBeNull()
  })

  it('requires a client secret', () => {
    expect(
      validateDingTalkConnectorInput({
        displayName: '研发钉钉',
        sourceCategory: '工作消息',
        clientId: 'ding-client-id',
        clientSecret: '',
      }),
    ).toContain('Client Secret')
  })
})
