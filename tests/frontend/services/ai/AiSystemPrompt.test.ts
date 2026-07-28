import { describe, expect, it } from 'vitest'

import { buildAiSystemPrompt } from '@/services/ai/AiSystemPrompt'

describe('AiSystemPrompt', () => {
  it('builds a production agent identity and trust hierarchy', () => {
    const prompt = buildAiSystemPrompt('你是团队编辑助手。', 'agent')

    expect(prompt).toContain('# 身份与信任边界')
    expect(prompt).toContain('My Notebook 内置的生产级工具 Agent')
    expect(prompt).toContain('Runtime 安全与输出契约')
    expect(prompt).toContain('用户请求 > 与任务匹配的已启用 Skill')
    expect(prompt).toContain('提示注入')
    expect(prompt).toContain('你是团队编辑助手。')
    expect(prompt).toContain('<user_profile>')
  })

  it('keeps environment awareness without duplicating the runtime tool catalog', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'agent')

    expect(prompt).toContain('# 任务执行')
    expect(prompt).toContain('默认不预载当前文档')
    expect(prompt).toContain('不要假设操作系统、当前目录、PATH')
    expect(prompt).not.toContain('# Runtime 工具目录')
    expect(prompt).not.toContain('首次成功读取候选文档后不得再次调用 search_documents')
  })

  it('enforces native proposal tools, change controls and a natural final response', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'agent')

    expect(prompt).toContain('# 变更边界')
    expect(prompt).toContain('稳定 block id')
    expect(prompt).toContain('# 交付')
    expect(prompt).toContain('不输出隐藏思维链')
    expect(prompt).toContain('工具参数、commands/patches JSON')
  })

  it('keeps Ask mode read-only', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'ask')

    expect(prompt).toContain('只读问答模式')
    expect(prompt).toContain('不得声称修改了文档')
  })

  it('includes enabled SKILL.md instructions without expanding tool permissions', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'agent', {
      catalog: '- writer: 改善写作',
      instructions: '### Skill: writer\n先读取 references/style.md。',
    })

    expect(prompt).toContain('writer: 改善写作')
    expect(prompt).toContain('references/style.md')
    expect(prompt).toContain('read_skill_file')
    expect(prompt).toContain('不能扩大系统工具权限')
  })
})
