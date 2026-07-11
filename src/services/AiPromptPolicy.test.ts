import { describe, expect, it } from 'vitest'

import { buildAiPrompt, resolveAiExecutionMode } from './AiPromptPolicy'

describe('AI prompt policy', () => {
  it('routes auto tasks by intent', () => {
    expect(resolveAiExecutionMode('auto', '检索知识库并对比资料')).toBe('agent')
    expect(resolveAiExecutionMode('auto', '润色当前段落')).toBe('edit')
    expect(resolveAiExecutionMode('auto', '这段话是什么意思')).toBe('ask')
  })

  it('adds the patch protocol only to write modes', () => {
    expect(buildAiPrompt('hello', 'ask')).toBe('hello')
    expect(buildAiPrompt('rewrite', 'edit')).toContain('只输出 JSON')
    expect(buildAiPrompt('research', 'agent')).toContain('知识库 Agent')
  })
})
