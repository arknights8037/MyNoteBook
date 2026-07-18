import { describe, expect, it } from 'vitest'

import { applyAgentBlockPatches } from '@/editor/agentBlockPatch'
import { findRelevantBlocksForInstruction } from '@/models/agent'
import { createRegexReplacePatches } from './AgentCommandService'
import { parseAgentResponse } from './AgentProtocol'

describe('Agent P1 deterministic edit flow', () => {
  it('locates a P0 block without selection and turns a model command into a confirmable patch', async () => {
    const blocks = [
      { id: 'p0', type: 'paragraph', text: '[ ] P0 完成可信修改闭环', index: 0 },
      { id: 'p1', type: 'paragraph', text: '[ ] P1 完成工具调用循环', index: 1 },
    ]
    const targetBlocks = findRelevantBlocksForInstruction('将 P0 事项标记为完成', blocks)
    const response = parseAgentResponse({
      output: JSON.stringify({
        commands: [
          {
            tool: 'replace_text_by_regex',
            pattern: '\\[ \\]',
            replacement: '[x]',
            flags: 'g',
            blockIds: ['p0'],
          },
        ],
      }),
      task: {
        id: 'task-1',
        sessionId: 'doc-1',
        status: 'running',
        userInstruction: '将 P0 事项标记为完成',
        contextScope: 'current_document',
        model: 'test',
        currentStep: '生成修改',
        createdAt: 1,
        completedAt: null,
        error: null,
      },
      documentId: 'doc-1',
      expectedRevision: 3,
      targetBlocks,
      contextSources: [],
      createId: () => 'patch-1',
    })
    const patches = (
      await Promise.all(
        response.commands.map((command) =>
          createRegexReplacePatches({
            command,
            taskId: 'task-1',
            documentId: 'doc-1',
            expectedVersion: 3,
            blocks: targetBlocks,
            replaceBlocksByRegex: async ({ blocks }) =>
              blocks.map((block) => ({ ...block, text: block.text.replace('[ ]', '[x]') })),
            createId: () => 'patch-1',
          }),
        ),
      )
    ).flat()
    const applied = applyAgentBlockPatches(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'p0' },
            content: [{ type: 'text', text: '[ ] P0 完成可信修改闭环' }],
          },
          {
            type: 'paragraph',
            attrs: { id: 'p1' },
            content: [{ type: 'text', text: '[ ] P1 完成工具调用循环' }],
          },
        ],
      },
      patches,
    )

    expect(targetBlocks.map((block) => block.id)).toEqual(['p0'])
    expect(patches).toMatchObject([
      { before: '[ ] P0 完成可信修改闭环', after: '[x] P0 完成可信修改闭环' },
    ])
    expect(applied.ok).toBe(true)
    expect(JSON.stringify(applied.content)).toContain('[x] P0 完成可信修改闭环')
    expect(JSON.stringify(applied.content)).toContain('[ ] P1 完成工具调用循环')
  })
})
