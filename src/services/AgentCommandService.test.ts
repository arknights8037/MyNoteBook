import { describe, expect, it } from 'vitest'

import { createAgentCommandPatches, createRegexReplacePatches } from './AgentCommandService'

describe('AgentCommandService', () => {
  it('creates deterministic, per-block patches from a regex command', async () => {
    const patches = await createRegexReplacePatches({
      command: {
        tool: 'replace_text_by_regex',
        pattern: '\\[ \\]',
        replacement: '[x]',
        flags: 'g',
        blockIds: ['p0'],
      },
      taskId: 'task',
      documentId: 'doc',
      expectedVersion: 2,
      blocks: [
        { id: 'p0', type: 'taskList', text: '[ ] P0 完成 Patch', index: 0 },
        { id: 'p1', type: 'taskList', text: '[ ] P1 工具循环', index: 1 },
      ],
      replaceBlocksByRegex: async ({ blocks }) =>
        blocks.map((block) => ({ ...block, text: block.text.replace('[ ]', '[x]') })),
      createId: () => 'patch',
    })

    expect(patches).toMatchObject([{ targetBlockIds: ['p0'], after: '[x] P0 完成 Patch' }])
  })

  it('rejects invalid regex without touching document content', async () => {
    await expect(
      createRegexReplacePatches({
        command: { tool: 'replace_text_by_regex', pattern: '[', replacement: '' },
        taskId: 'task',
        documentId: 'doc',
        expectedVersion: 1,
        blocks: [{ id: 'p0', type: 'paragraph', text: '内容', index: 0 }],
        replaceBlocksByRegex: async () => {
          throw new Error('正则表达式无效。')
        },
        createId: () => 'patch',
      }),
    ).rejects.toThrow('正则表达式无效')
  })

  it('requires the composition root to provide the safe regex executor', async () => {
    await expect(
      createRegexReplacePatches({
        command: { tool: 'replace_text_by_regex', pattern: '旧', replacement: '新' },
        taskId: 'task',
        documentId: 'doc',
        expectedVersion: 1,
        blocks: [{ id: 'p0', type: 'paragraph', text: '旧内容', index: 0 }],
        createId: () => 'patch',
      }),
    ).rejects.toThrow('未提供安全正则替换器')
  })

  it('creates scoped replace and insert patches', async () => {
    const base = {
      taskId: 'task',
      documentId: 'doc',
      expectedVersion: 3,
      blocks: [{ id: 'b1', type: 'paragraph', text: '旧内容', index: 0 }],
      createId: () => 'patch',
    }
    expect(
      (
        await createAgentCommandPatches({
          ...base,
          command: { tool: 'replace_block', blockId: 'b1', content: '新内容' },
        })
      )[0],
    ).toMatchObject({ operation: 'replace', before: '旧内容', after: '新内容' })
    expect(
      (
        await createAgentCommandPatches({
          ...base,
          command: {
            tool: 'insert_blocks',
            anchorBlockId: 'b1',
            position: 'after',
            content: '补充',
          },
        })
      )[0],
    ).toMatchObject({ operation: 'insert_after', targetBlockIds: ['b1'], after: '补充' })
  })

  it('rejects block commands outside the allowed scope', async () => {
    await expect(
      createAgentCommandPatches({
        command: { tool: 'replace_block', blockId: 'other', content: '越权修改' },
        taskId: 'task',
        documentId: 'doc',
        expectedVersion: 1,
        blocks: [{ id: 'b1', type: 'paragraph', text: '内容', index: 0 }],
        createId: () => 'patch',
      }),
    ).rejects.toThrow('不在本次允许范围内')
  })

  it('creates an isolated document proposal', async () => {
    let sequence = 0
    const patches = await createAgentCommandPatches({
      command: { tool: 'create_document', title: '会议纪要', content: '# 会议纪要\n\n正文' },
      taskId: 'task',
      documentId: 'parent',
      expectedVersion: 4,
      blocks: [],
      createId: () => `id-${++sequence}`,
    })
    expect(patches[0]).toMatchObject({
      operation: 'create_document',
      documentId: 'id-2',
      documentTitle: '会议纪要',
      parentDocumentId: 'parent',
      expectedVersion: 0,
      targetBlockIds: [],
    })
  })

  it('allows a document proposal under a group discovered during the task', async () => {
    const patches = await createAgentCommandPatches({
      command: {
        tool: 'create_document',
        title: '知识库概念简介',
        content: '# 知识库概念简介\n\n正文',
        parentDocumentId: 'group-agent-mvp',
      },
      taskId: 'task',
      documentId: 'current',
      expectedVersion: 4,
      blocks: [],
      allowedParentDocumentIds: ['group-agent-mvp'],
      createId: () => 'new-document',
    })

    expect(patches[0]).toMatchObject({
      operation: 'create_document',
      parentDocumentId: 'group-agent-mvp',
    })
  })

  it('creates an atomic group proposal with an initial document', async () => {
    let sequence = 0
    const patches = await createAgentCommandPatches({
      command: {
        tool: 'create_group',
        title: '知识库软件',
        initialDocument: {
          title: '常见知识库软件功能与用途',
          content: '# 常见知识库软件功能与用途\n\n正文',
        },
      },
      taskId: 'task',
      documentId: 'current',
      expectedVersion: 4,
      blocks: [],
      createId: () => `id-${++sequence}`,
    })
    expect(patches).toMatchObject([
      {
        patchId: 'id-1',
        operation: 'create_group',
        documentId: 'id-2',
        blockId: 'id-3',
        documentTitle: '知识库软件',
        parentDocumentId: null,
        before: '常见知识库软件功能与用途',
        after: '# 常见知识库软件功能与用途\n\n正文',
      },
    ])
  })
})
