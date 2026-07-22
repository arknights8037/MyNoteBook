import { describe, expect, it } from 'vitest'

import { createAgentTask } from '@/models/agent/agent'
import { parseAgentResponse } from '@/services/agent/AgentProtocol'

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

  it('targets a non-current document only when that document was read in this run', () => {
    const output = JSON.stringify({
      patches: [
        {
          documentId: 'doc-2',
          operation: 'replace',
          blockId: 'remote-1',
          targetBlockIds: ['remote-1'],
          after: '同步后的内容',
          reason: '同步记录',
        },
      ],
    })
    const unread = parseAgentResponse({ ...baseInput, output })
    const read = parseAgentResponse({
      ...baseInput,
      output,
      readableDocuments: [
        {
          documentId: 'doc-2',
          expectedVersion: 7,
          blocks: [{ id: 'remote-1', type: 'paragraph', text: '旧内容', index: 0 }],
        },
      ],
    })

    expect(unread.patchSet).toBeNull()
    expect(read.patchSet?.patches[0]).toMatchObject({
      documentId: 'doc-2',
      expectedVersion: 7,
      before: '旧内容',
    })
  })

  it('prefers an explicitly read canonical block snapshot for the current document', () => {
    const response = parseAgentResponse({
      ...baseInput,
      targetBlocks: [{ id: 'table-1', type: 'tableBlock', text: '', index: 0 }],
      readableDocuments: [
        {
          documentId: 'doc-1',
          expectedVersion: 1,
          blocks: [
            { id: 'table-1', type: 'tableBlock', text: '字段\t说明', index: 0 },
          ],
        },
      ],
      output: JSON.stringify({
        patches: [
          {
            documentId: 'doc-1',
            operation: 'replace',
            blockId: 'table-1',
            targetBlockIds: ['table-1'],
            after: '字段\t新说明',
            reason: '更新表格',
          },
        ],
      }),
    })

    expect(response.patchSet?.patches[0]?.before).toBe('字段\t说明')
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

  it('uses the shared write contract to ignore structurally invalid commands', () => {
    const response = parseAgentResponse({
      ...baseInput,
      output: JSON.stringify({
        commands: [
          { tool: 'replace_block', blockId: '', content: '替换' },
          { tool: 'replace_text_by_regex', pattern: '', replacement: '完成' },
        ],
      }),
    })

    expect(response.commands).toEqual([])
  })
})
