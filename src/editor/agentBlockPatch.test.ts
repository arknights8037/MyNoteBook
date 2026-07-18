import { describe, expect, it } from 'vitest'

import { applyAgentBlockPatches } from './agentBlockPatch'
import type { BlockPatch } from '@/models/agent'
import type { TiptapDocumentJson } from '@/models/document'

const content: TiptapDocumentJson = {
  type: 'doc',
  content: [
    paragraph('block-1', '保留第一段'),
    paragraph('block-2', '替换第二段'),
    paragraph('block-3', '保留第三段'),
  ],
}

function paragraph(id: string, text: string) {
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] }
}

function patch(targetBlockIds: string[]): BlockPatch {
  return {
    patchId: 'patch-1',
    taskId: 'task-1',
    operation: 'replace',
    documentId: 'doc-1',
    blockId: targetBlockIds[0] ?? '',
    targetBlockIds,
    expectedVersion: 1,
    before: '替换第二段',
    after: '## 新标题\n\n新的正文',
    reason: '测试',
    accepted: true,
  }
}

describe('applyAgentBlockPatches', () => {
  it('replaces a detached target range and preserves surrounding blocks', () => {
    const result = applyAgentBlockPatches(content, [patch(['block-2'])])

    expect(result.ok).toBe(true)
    expect(result.content?.content).toHaveLength(4)
    expect(content.content).toHaveLength(3)
  })

  it('rejects non-contiguous block replacement before a database write is attempted', () => {
    const result = applyAgentBlockPatches(content, [patch(['block-1', 'block-3'])])

    expect(result).toEqual({
      ok: false,
      error: '替换补丁的目标块必须连续，已阻止写入。',
    })
  })
})
