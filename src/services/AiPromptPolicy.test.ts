import { describe, expect, it } from 'vitest'

import { buildAiPrompt, inferAiAgentIntent, resolveAiExecutionMode } from './AiPromptPolicy'

describe('AI prompt policy', () => {
  it('routes auto tasks by intent', () => {
    expect(resolveAiExecutionMode('auto', '检索知识库并对比资料')).toBe('agent')
    expect(resolveAiExecutionMode('auto', '润色当前段落')).toBe('edit')
    expect(resolveAiExecutionMode('auto', '这段话是什么意思')).toBe('ask')
    expect(resolveAiExecutionMode('auto', '创建页面')).toBe('agent')
    expect(resolveAiExecutionMode('auto', '帮我新建一篇《会议纪要》文档')).toBe('agent')
    expect(inferAiAgentIntent('创建页面')).toBe('create')
    expect(inferAiAgentIntent('检索知识库')).toBe('default')
  })

  it('adds the patch protocol only to write modes', () => {
    expect(buildAiPrompt('hello', 'ask')).toBe('hello')
    expect(buildAiPrompt('rewrite', 'edit')).toContain('只输出 JSON')
    expect(buildAiPrompt('research', 'agent')).toContain('知识库 Agent')
  })
})
