import { describe, expect, it } from 'vitest'

import { buildAiSystemPrompt } from './AiSystemPrompt'

describe('AiSystemPrompt', () => {
  it('keeps the user base prompt while adding the controlled edit contract', () => {
    const prompt = buildAiSystemPrompt('你是团队编辑助手。', 'agent')

    expect(prompt).toContain('你是团队编辑助手。')
    expect(prompt).toContain('replace_text_by_regex')
    expect(prompt).toContain('execute_shell')
    expect(prompt).toContain('原生 function calling')
    expect(prompt).toContain('不要在正文中手写 toolCalls JSON')
    expect(prompt).toContain('强制校验为 JSON')
  })

  it('keeps Ask mode read-only', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'ask')

    expect(prompt).toContain('只读问答模式')
    expect(prompt).toContain('不得声称修改了文档')
  })
})
