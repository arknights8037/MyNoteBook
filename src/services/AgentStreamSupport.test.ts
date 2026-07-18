import { describe, expect, it, vi } from 'vitest'

import { createLiveReasoningEmitter, mergeLanguageModelUsage } from './AgentStreamSupport'

describe('AgentStreamSupport', () => {
  it('suppresses streamed JSON protocol while forwarding natural language', () => {
    const emit = vi.fn()
    const protocol = createLiveReasoningEmitter(emit)
    protocol.push('{"outcome":')
    protocol.push('"blocked"}')
    expect(emit).not.toHaveBeenCalled()

    const content = createLiveReasoningEmitter(emit)
    content.push('正在分析')
    content.push('相关资料')
    expect(emit.mock.calls.flat()).toEqual(['正在分析', '相关资料'])
  })

  it('merges optional token usage without inventing absent fields', () => {
    expect(mergeLanguageModelUsage({ inputTokens: 4 }, { outputTokens: 6 })).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: undefined,
    })
  })
})
