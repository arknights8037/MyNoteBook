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
