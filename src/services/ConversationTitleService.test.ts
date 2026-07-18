import { describe, expect, it, vi } from 'vitest'

import { createAiSettings } from '@/models/ai'
import { generateConversationTitle, normalizeConversationTitle } from './ConversationTitleService'

describe('ConversationTitleService', () => {
  it('uses a bounded background completion and normalizes its title', async () => {
    const runCompletion = vi.fn(async () => '标题："修复对话排序"。\n多余解释')
    const settings = { ...createAiSettings('openai-compatible'), maxTokens: 2048 }

    await expect(
      generateConversationTitle('修复对话排序问题', settings, runCompletion),
    ).resolves.toBe('修复对话排序')
    expect(runCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ maxTokens: 64, reasoningEffort: 'auto' }),
      }),
    )
  })

  it('removes markdown and quotation decoration', () => {
    expect(normalizeConversationTitle('## “知识库写回审查”')).toBe('知识库写回审查')
  })
})
