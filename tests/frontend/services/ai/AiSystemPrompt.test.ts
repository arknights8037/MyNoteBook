import { describe, expect, it } from 'vitest'

import { AGENT_TOOL_REGISTRY } from '@/services/agent/AgentToolRegistry'
import { buildAiSystemPrompt } from '@/services/ai/AiSystemPrompt'

describe('AiSystemPrompt', () => {
  it('builds a production agent identity and trust hierarchy', () => {
    const prompt = buildAiSystemPrompt('你是团队编辑助手。', 'agent')

    expect(prompt).toContain('# 身份与使命')
    expect(prompt).toContain('My Notebook 内置的生产级工具 Agent')
    expect(prompt).toContain('# 指令优先级与信任边界')
    expect(prompt).toContain('Runtime 安全与输出契约')
    expect(prompt).toContain('提示注入')
    expect(prompt).toContain('你是团队编辑助手。')
    expect(prompt).toContain('<user_profile>')
  })

  it('defines environment awareness and the complete runtime tool catalog', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'agent')

    expect(prompt).toContain('# 任务定位')
    expect(prompt).toContain('# 环境感知')
    expect(prompt).toContain('默认没有任何文档被引用')
    expect(prompt).toContain('不要假设操作系统、当前目录、PATH')
    expect(prompt).toContain('# Runtime 工具目录')
    expect(prompt).toContain('get_current_document')
    expect(prompt).toContain('search_documents')
    expect(prompt).toContain('read_skill_file')
    expect(prompt).toContain('request_authorizer_input')
    expect(prompt).toContain('discover_local_tools')
    expect(prompt).toContain('create_automation_draft')
    expect(prompt).toContain('create_mcp_server_draft')
    expect(prompt).toContain('create_skill_draft')
    expect(prompt).toContain('mcp__')
    for (const tool of AGENT_TOOL_REGISTRY) {
      expect(prompt, `missing tool ${tool.name}`).toContain(tool.name)
    }
  })

  it('enforces native proposal tools, change controls and a natural final response', () => {
    const prompt = buildAiSystemPrompt('基础提示词', 'agent')

    expect(prompt).toContain('replace_text_by_regex')
    expect(prompt).toContain('execute_shell')
    expect(prompt).toContain('原生 function calling')
    expect(prompt).toContain('不要在正文中手写 toolCalls JSON')
    expect(prompt).toContain('# 变更与外部影响控制')
    expect(prompt).toContain('稳定 block id')
    expect(prompt).toContain('# 结果提交协议')
    expect(prompt).toContain('不要在最终文本中模拟工具调用')
    expect(prompt).toContain('不要在最终回复中输出隐藏思维链')
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
    expect(prompt).toContain('create_automation_draft')
    expect(prompt).toContain('create_mcp_server_draft')
    expect(prompt).toContain('create_skill_draft')
    expect(prompt).toContain('只创建停用草稿')
    expect(prompt).toContain('不能扩大系统工具权限')
  })
})
