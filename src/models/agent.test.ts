import { describe, expect, it } from 'vitest'

import { findRelevantBlocksForInstruction, validateBlockPatch, type BlockPatch } from './agent'

function createPatch(overrides: Partial<BlockPatch> = {}): BlockPatch {
  return {
    patchId: 'patch-1',
    taskId: 'task-1',
    operation: 'replace',
    documentId: 'doc-1',
    blockId: 'block-1',
    targetBlockIds: ['block-1'],
    expectedVersion: 3,
    before: 'Before',
    after: 'After',
    reason: 'Test',
    accepted: true,
    ...overrides,
  }
}

describe('agent patch validation', () => {
  it('finds likely target blocks without requiring a manual selection', () => {
    const blocks = [
      { id: 'p0', type: 'paragraph', text: 'P0 任务看板：完成 Patch 校验。', index: 0 },
      { id: 'p1', type: 'paragraph', text: 'P1 工具调用循环。', index: 1 },
    ]

    expect(
      findRelevantBlocksForInstruction('将 P0 事项标记为完成', blocks).map((block) => block.id),
    ).toEqual(['p0'])
  })
  it('accepts a patch that targets the current document and revision', () => {
    expect(
      validateBlockPatch(createPatch(), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-1'],
      }),
    ).toEqual({ ok: true, error: null })
  })

  it('rejects a patch for another document', () => {
    const result = validateBlockPatch(createPatch({ documentId: 'doc-2' }), {
      documentId: 'doc-1',
      expectedVersion: 3,
      availableBlockIds: ['block-1'],
    })

    expect(result.ok).toBe(false)
  })

  it('rejects stale revisions and missing target blocks', () => {
    expect(
      validateBlockPatch(createPatch(), {
        documentId: 'doc-1',
        expectedVersion: 4,
        availableBlockIds: ['block-1'],
      }).ok,
    ).toBe(false)

    expect(
      validateBlockPatch(createPatch(), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-2'],
      }).ok,
    ).toBe(false)
  })

  it('rejects empty generated content', () => {
    const result = validateBlockPatch(createPatch({ after: '   ' }), {
      documentId: 'doc-1',
      expectedVersion: 3,
      availableBlockIds: ['block-1'],
    })

    expect(result.ok).toBe(false)
  })

  it('accepts P1 insert operations and rejects malformed block targets', () => {
    expect(
      validateBlockPatch(createPatch({ operation: 'append' }), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-1'],
      }).ok,
    ).toBe(true)

    expect(
      validateBlockPatch(createPatch({ blockId: 'block-2' }), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-1', 'block-2'],
      }).ok,
    ).toBe(false)

    expect(
      validateBlockPatch(createPatch({ targetBlockIds: ['block-1', 'block-1'] }), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-1'],
      }).ok,
    ).toBe(false)

    expect(
      validateBlockPatch(
        createPatch({
          operation: 'insert_after',
          targetBlockIds: ['block-1', 'block-2'],
        }),
        {
          documentId: 'doc-1',
          expectedVersion: 3,
          availableBlockIds: ['block-1', 'block-2'],
        },
      ).ok,
    ).toBe(false)
  })

  it('rejects a replace patch that does not change canonical text', () => {
    const result = validateBlockPatch(createPatch({ after: ' Before\r\n' }), {
      documentId: 'doc-1',
      expectedVersion: 3,
      availableBlockIds: ['block-1'],
    })

    expect(result).toEqual({ ok: false, error: '补丁修改前后内容相同，无需写入。' })
  })

  it('rejects patches when the current block text no longer matches before', () => {
    expect(
      validateBlockPatch(createPatch(), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-1'],
        currentBlocks: [{ id: 'block-1', type: 'paragraph', text: 'Before', index: 0 }],
      }).ok,
    ).toBe(true)

    expect(
      validateBlockPatch(createPatch(), {
        documentId: 'doc-1',
        expectedVersion: 3,
        availableBlockIds: ['block-1'],
        currentBlocks: [{ id: 'block-1', type: 'paragraph', text: 'Changed', index: 0 }],
      }).ok,
    ).toBe(false)
  })
})
