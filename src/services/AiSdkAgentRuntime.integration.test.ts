import { describe, expect, it } from 'vitest'

import { createAiSettings } from '@/models/ai'
import type { AgentToolExecutionResult, AgentToolRequest } from './AgentToolExecutor'
import { runAgentToolLoop } from './AgentRuntime'
import { buildAiSystemPrompt } from './AiSystemPrompt'

const apiKey = process.env.DEEPSEEK_API_KEY
const liveIt = apiKey ? it : it.skip

describe('DeepSeek Agent live workflow', () => {
  liveIt(
    'chooses knowledge tools from a natural user request and returns a scoped patch',
    async () => {
      const settings = createAiSettings('deepseek')
      settings.apiKey = apiKey ?? ''
      settings.model = 'deepseek-chat'
      settings.temperature = 0.1
      settings.maxTokens = 1200

      const executedTools: string[] = []
      const result = await runAgentToolLoop({
        taskId: 'live-deepseek-agent',
        prompt: '这段写得有点含糊。你翻翻知识库里的差旅规定，帮我补得清楚些。',
        context: [
          '当前页面：新员工常见问题',
          '本次需要修改的目标块：',
          '[block-travel] 出差回来之后尽快报销，票据要留好。',
        ].join('\n'),
        settings,
        systemPrompt: [
          '你是本地知识库编辑助手。涉及知识库事实时先检索并阅读相关文档。',
          '你只能提出待用户确认的修改，不能声称已经写入。',
          '只可修改 block-travel。最终返回 commands 或 patches。',
        ].join('\n'),
        createId: () => crypto.randomUUID(),
        executeTool: async (request) => {
          executedTools.push(request.name)
          return executeFixtureTool(request)
        },
        recordToolCall: async () => undefined,
      })

      const output = JSON.parse(result.output) as {
        patches?: Array<{ blockId?: string; targetBlockIds?: string[]; after?: string }>
        commands?: unknown[]
        finalAnswer?: string
      }
      expect(executedTools).toContain('search_documents')
      expect(executedTools).toContain('read_document')
      expect(output.patches?.[0]).toMatchObject({
        blockId: 'block-travel',
        targetBlockIds: ['block-travel'],
      })
      expect(output.patches?.[0]?.after).toContain('10')
      expect(output.finalAnswer).not.toMatch(/已经|已写入|已保存/)
    },
    120_000,
  )

  liveIt(
    'chooses the local document creation proposal from a natural request',
    async () => {
      const settings = createAiSettings('deepseek')
      settings.apiKey = apiKey ?? ''
      settings.model = 'deepseek-chat'
      settings.temperature = 0.1
      settings.maxTokens = 1000

      const result = await runAgentToolLoop({
        taskId: 'live-deepseek-create-document',
        prompt: '在当前页面下面新建一篇《发布检查清单》，列上构建、测试和回滚准备这三项。',
        context: [
          '当前页面：Agent 开发记录',
          'documentId: doc-current',
          '本次需要修改的目标块：',
          '[block-notes] 今天完成了运行时测试。',
        ].join('\n'),
        settings,
        systemPrompt: buildAiSystemPrompt('你是本地知识库编辑助手。', 'agent'),
        createId: () => crypto.randomUUID(),
        executeTool: async () => ({ ok: false, error: '本任务不需要读取工具。' }),
        recordToolCall: async () => undefined,
      })

      const output = JSON.parse(result.output) as {
        commands?: Array<{ tool?: string; title?: string; content?: string }>
        patches?: unknown[]
      }
      expect(output.commands).toHaveLength(1)
      expect(output.commands?.[0]).toMatchObject({
        tool: 'create_document',
        title: '发布检查清单',
      })
      expect(output.commands?.[0]?.content).toMatch(/构建|测试|回滚/)
      expect(output.patches ?? []).toHaveLength(0)
    },
    120_000,
  )
})

async function executeFixtureTool(request: AgentToolRequest): Promise<AgentToolExecutionResult> {
  if (request.name === 'search_documents') {
    return {
      ok: true,
      value: [
        {
          documentId: 'policy-travel',
          title: '差旅报销管理规定',
          snippet: '返程后 10 个工作日内提交报销。',
          revision: 3,
        },
      ],
    }
  }
  if (request.name === 'read_document') {
    return {
      ok: true,
      value: {
        id: 'policy-travel',
        title: '差旅报销管理规定',
        revision: 3,
        text: '员工应在返程后 10 个工作日内提交报销，并附发票、行程单和审批记录。票据遗失时需提交书面说明。',
      },
    }
  }
  if (request.name === 'get_current_document') {
    return {
      ok: true,
      value: {
        id: 'current',
        title: '新员工常见问题',
        revision: 1,
        blocks: [{ id: 'block-travel', text: '出差回来之后尽快报销，票据要留好。' }],
      },
    }
  }
  return { ok: false, error: `测试未提供工具 ${request.name}` }
}
