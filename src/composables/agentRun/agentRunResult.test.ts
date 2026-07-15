import { describe, expect, it } from 'vitest'

import { createAgentTask } from '@/models/agent'
import { createAiSettings } from '@/models/ai'
import { resolveAgentRunResult } from './agentRunResult'
import type { AgentRunSnapshot } from './types'

describe('resolveAgentRunResult', () => {
  it('converts structured write commands into a pending patch set', async () => {
    const result = await resolveAgentRunResult({
      ...baseInput(),
      output: JSON.stringify({
        outcome: 'proposal',
        finalAnswer: '已完成改写',
        commands: [{ tool: 'replace_block', blockId: 'b1', content: '新正文' }],
      }),
    })

    expect(result.summary).toBe('已完成改写')
    expect(result.patchSet?.patches).toMatchObject([
      { operation: 'replace', blockId: 'b1', before: '旧正文', after: '新正文' },
    ])
  })

  it('rejects a create-document command mixed with another proposal', async () => {
    await expect(
      resolveAgentRunResult({
        ...baseInput(),
        output: JSON.stringify({
          commands: [
            { tool: 'create_document', title: '新文档', content: '内容' },
            { tool: 'replace_block', blockId: 'b1', content: '新正文' },
          ],
        }),
      }),
    ).rejects.toThrow('新建文档或分组不能和其他修改混在同一批提案中')
  })

  it('rejects multiple patches that target the same block', async () => {
    await expect(
      resolveAgentRunResult({
        ...baseInput(),
        output: JSON.stringify({
          outcome: 'proposal',
          patches: [
            {
              documentId: 'doc-1',
              operation: 'replace',
              blockId: 'b1',
              targetBlockIds: ['b1'],
              after: '第一次修改',
              reason: '改写',
            },
            {
              documentId: 'doc-1',
              operation: 'insert_after',
              blockId: 'b1',
              targetBlockIds: ['b1'],
              after: '第二次修改',
              reason: '补充',
            },
          ],
        }),
      }),
    ).rejects.toThrow('多个补丁不能修改同一个目标块')
  })

  it('accepts one proposal that synchronizes multiple read documents', async () => {
    const result = await resolveAgentRunResult({
      ...baseInput(),
      readableDocuments: [
        {
          documentId: 'doc-2',
          documentTitle: '第二篇文档',
          expectedVersion: 1,
          blocks: [{ id: 'b2', type: 'paragraph', text: '第二篇正文', index: 0 }],
        },
      ],
      output: JSON.stringify({
        outcome: 'proposal',
        patches: [
          {
            documentId: 'doc-1',
            operation: 'replace',
            blockId: 'b1',
            targetBlockIds: ['b1'],
            after: '第一篇修改',
            reason: '同步',
          },
          {
            documentId: 'doc-2',
            operation: 'replace',
            blockId: 'b2',
            targetBlockIds: ['b2'],
            after: '第二篇修改',
            reason: '同步',
          },
        ],
      }),
    })

    expect(result.patchSet?.patches.map((patch) => patch.documentId)).toEqual(['doc-1', 'doc-2'])
  })

  it('converts a create-group command with its initial document into one proposal', async () => {
    const result = await resolveAgentRunResult({
      ...baseInput(),
      output: JSON.stringify({
        outcome: 'proposal',
        commands: [
          {
            tool: 'create_group',
            title: '知识库软件',
            initialDocument: { title: '功能与用途', content: '# 功能与用途\n\n正文' },
          },
        ],
      }),
    })

    expect(result.patchSet?.patches).toMatchObject([
      {
        operation: 'create_group',
        documentTitle: '知识库软件',
        before: '功能与用途',
        after: '# 功能与用途\n\n正文',
      },
    ])
  })
})

function baseInput() {
  const settings = createAiSettings('openai')
  settings.model = 'test-model'
  const snapshot: AgentRunSnapshot = {
    prompt: '改写正文',
    requestedMode: 'edit',
    settings,
    document: {
      id: 'doc-1',
      title: '文档',
      tags: [],
      sourceUrl: '',
      author: '',
      text: '旧正文',
      revision: 2,
      blocks: [{ id: 'b1', type: 'paragraph', text: '旧正文', index: 0 }],
      selectedBlocks: [],
      hasBlockSelection: false,
      documents: [],
    },
  }
  return {
    mode: 'edit' as const,
    task: createAgentTask({
      id: 'task-1',
      sessionId: 'doc-1',
      userInstruction: '改写正文',
      contextScope: 'current_block',
      model: 'test-model',
    }),
    snapshot,
    expectedRevision: 2,
    targetBlocks: snapshot.document.blocks,
    sources: [],
    usesSelection: false,
    foundTargetScope: true,
    replaceBlocksByRegex: async ({ blocks }) => blocks,
    createId: (() => {
      let index = 0
      return () => `id-${++index}`
    })(),
  }
}
