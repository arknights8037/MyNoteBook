import { describe, expect, it } from 'vitest'

import { createAgentTask } from '@/models/agent'
import { parseAgentResponse } from './AgentProtocol'

const task = createAgentTask({
  id: 'task-1',
  sessionId: 'doc-1',
  userInstruction: '改写',
  contextScope: 'selection',
  model: 'test',
})
const baseInput = {
  task,
  documentId: 'doc-1',
  expectedRevision: 1,
  targetBlocks: [
    { id: 'b1', type: 'paragraph', text: '第一段', index: 0 },
    { id: 'b2', type: 'paragraph', text: '第二段', index: 1 },
  ],
  contextSources: [],
  createId: () => 'patch-id',
}

describe('AgentProtocol', () => {
  it('parses multiple structured patch operations without accepting arbitrary output', () => {
    const response = parseAgentResponse({
      ...baseInput,
      output: JSON.stringify({
        patches: [
          {
            operation: 'replace',
            blockId: 'b1',
            targetBlockIds: ['b1'],
            after: '新第一段',
            reason: '改写',
          },
          {
            operation: 'insert_after',
            blockId: 'b2',
            targetBlockIds: ['b2'],
            after: '补充段落',
            reason: '补充',
          },
        ],
      }),
    })

    expect(response.patchSet?.patches).toHaveLength(2)
    expect(response.patchSet?.patches[1]).toMatchObject({
      operation: 'insert_after',
      before: '第二段',
    })
  })

  it('turns free-form Markdown into one explicitly marked fallback patch', () => {
    const response = parseAgentResponse({ ...baseInput, output: '# 不是 JSON' })

    expect(response.usedMarkdownFallback).toBe(true)
    expect(response.patchSet?.patches).toMatchObject([
      { operation: 'replace', targetBlockIds: ['b1', 'b2'] },
    ])
  })

  it('extracts a JSON object wrapped in model commentary', () => {
    const response = parseAgentResponse({
      ...baseInput,
      output:
        '下面是结果：\n{"patches":[{"operation":"replace","blockId":"b1","after":"改写"}]}\n请确认。',
    })

    expect(response.usedMarkdownFallback).toBe(false)
    expect(response.patchSet?.patches).toHaveLength(1)
  })

  it('parses direct regex commands separately from generated patches', () => {
    const response = parseAgentResponse({
      ...baseInput,
      output: JSON.stringify({
        commands: [
          {
            tool: 'replace_text_by_regex',
            pattern: '待办',
            replacement: '已完成',
            blockIds: ['b1'],
          },
        ],
      }),
    })

    expect(response.commands).toHaveLength(1)
    expect(response.patchSet).toBeNull()
  })

  it('parses the three local structured write commands', () => {
    const response = parseAgentResponse({
      ...baseInput,
      output: JSON.stringify({
        commands: [
          { tool: 'replace_block', blockId: 'b1', content: '替换' },
          { tool: 'insert_blocks', anchorBlockId: 'b2', position: 'after', content: '新增' },
          { tool: 'create_document', title: '子页面', content: '# 子页面' },
        ],
      }),
    })
    expect(response.commands.map((command) => command.tool)).toEqual([
      'replace_block',
      'insert_blocks',
      'create_document',
    ])
  })
})
