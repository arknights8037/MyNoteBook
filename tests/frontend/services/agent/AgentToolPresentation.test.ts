import { describe, expect, it } from 'vitest'

import type { AgentToolCall } from '@/models/agent/agentTool'
import { presentAgentToolCall } from '@/services/agent/AgentToolPresentation'

function toolCall(resultJson: string): AgentToolCall {
  return {
    id: 'call-1',
    taskId: 'task-1',
    toolName: 'mcp__exa__web_search_exa',
    argumentsJson: JSON.stringify({ query: 'agent loop UX', limit: 5 }),
    resultJson,
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
    error: null,
  }
}

describe('AgentToolPresentation', () => {
  it('unwraps MCP text content and projects web results as human-readable links', () => {
    const resultJson = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              {
                title: 'Designing effective agent loops',
                url: 'https://example.com/agent-loops',
                text: 'A practical guide to tool calls, observations, and final summaries.',
              },
            ],
          }),
        },
      ],
    })

    expect(presentAgentToolCall(toolCall(resultJson))).toMatchObject({
      inputFields: [
        { label: '搜索内容', value: 'agent loop UX' },
        { label: '数量上限', value: '5' },
      ],
      resultCount: 1,
      resultItems: [
        {
          title: 'Designing effective agent loops',
          url: 'https://example.com/agent-loops',
          description: expect.stringContaining('practical guide'),
        },
      ],
    })
  })

  it('keeps non-link tool output readable without serializing the whole object', () => {
    const result = presentAgentToolCall(
      toolCall(JSON.stringify({ created: true, id: 'exa', name: 'Exa' })),
    )

    expect(result.resultText).toContain('草稿已创建')
    expect(result.resultItems).toEqual([])
  })

  it('projects knowledge-base results as internal document targets', () => {
    const result = presentAgentToolCall(
      toolCall(
        JSON.stringify([
          {
            id: 'document-1',
            blockId: 'block-7',
            title: '差旅制度',
            snippet: '跨部门出差需要额外审批。',
          },
        ]),
      ),
    )

    expect(result.resultItems[0]).toMatchObject({
      title: '差旅制度',
      documentId: 'document-1',
      blockId: 'block-7',
      url: null,
    })
  })
})
