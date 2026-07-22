import { describe, expect, it } from 'vitest'

import { formatAiErrorMessage } from '@/services/ai/AiErrorMessage'

describe('formatAiErrorMessage', () => {
  it('turns an insufficient balance provider error into an actionable message', () => {
    const error = Object.assign(new Error('No output generated'), {
      cause: new Error('Insufficient Balance'),
    })

    expect(formatAiErrorMessage(error)).toBe(
      '当前 AI Provider 账户余额不足。请充值，或在 AI 设置中切换 Provider / API Key 后重试。',
    )
  })

  it('preserves an unknown runtime error', () => {
    expect(formatAiErrorMessage(new Error('连接失败'))).toBe('连接失败')
  })
})
