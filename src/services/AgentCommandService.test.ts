import { describe, expect, it } from 'vitest'

import { createAgentCommandPatches, createRegexReplacePatches } from './AgentCommandService'

describe('AgentCommandService', () => {
  it('creates deterministic, per-block patches from a regex command', () => {
    const patches = createRegexReplacePatches({
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
      createId: () => 'patch',
    })

    expect(patches).toMatchObject([{ targetBlockIds: ['p0'], after: '[x] P0 完成 Patch' }])
  })

  it('rejects invalid regex without touching document content', () => {
    expect(() =>
      createRegexReplacePatches({
        command: { tool: 'replace_text_by_regex', pattern: '[', replacement: '' },
        taskId: 'task',
        documentId: 'doc',
        expectedVersion: 1,
        blocks: [{ id: 'p0', type: 'paragraph', text: '内容', index: 0 }],
        createId: () => 'patch',
      }),
    ).toThrow('正则表达式无效')
  })

  it('creates scoped replace and insert patches', () => {
    const base = {
      taskId: 'task',
      documentId: 'doc',
      expectedVersion: 3,
      blocks: [{ id: 'b1', type: 'paragraph', text: '旧内容', index: 0 }],
      createId: () => 'patch',
    }
    expect(
      createAgentCommandPatches({
        ...base,
        command: { tool: 'replace_block', blockId: 'b1', content: '新内容' },
      })[0],
    ).toMatchObject({ operation: 'replace', before: '旧内容', after: '新内容' })
    expect(
      createAgentCommandPatches({
        ...base,
        command: { tool: 'insert_blocks', anchorBlockId: 'b1', position: 'after', content: '补充' },
      })[0],
    ).toMatchObject({ operation: 'insert_after', targetBlockIds: ['b1'], after: '补充' })
  })

  it('rejects block commands outside the allowed scope', () => {
    expect(() =>
      createAgentCommandPatches({
        command: { tool: 'replace_block', blockId: 'other', content: '越权修改' },
        taskId: 'task',
        documentId: 'doc',
        expectedVersion: 1,
        blocks: [{ id: 'b1', type: 'paragraph', text: '内容', index: 0 }],
        createId: () => 'patch',
      }),
    ).toThrow('不在本次允许范围内')
  })

  it('creates an isolated document proposal', () => {
    let sequence = 0
    const patches = createAgentCommandPatches({
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
})
