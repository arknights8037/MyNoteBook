import type { JSONContent } from '@tiptap/vue-3'

import { ensureTopLevelBlockIds } from './blockId'
import { cloneEditorContent } from './editorContent'
import { parseMarkdownDocument } from './markdownImport'
import type { BlockPatch } from '@/models/agent'
import type { TiptapDocumentJson } from '@/models/document'

export interface ApplyBlockPatchResult {
  ok: boolean
  content?: TiptapDocumentJson
  error?: string
}

/** Applies accepted P0 replace patches to a detached JSON document before it is committed to SQLite. */
export function applyAgentBlockPatches(
  source: TiptapDocumentJson,
  patches: BlockPatch[],
): ApplyBlockPatchResult {
  if (
    patches.some(
      (patch) => patch.operation === 'create_document' || patch.operation === 'create_group',
    )
  ) {
    return { ok: false, error: '新建文档或分组提案必须由创建事务执行器处理。' }
  }
  const content = cloneEditorContent(source)
  const blocks = content.content ?? []
  const resolved = patches.map((patch) => resolvePatchRange(blocks, patch))
  const failure = resolved.find((item) => typeof item === 'string')
  if (failure) return { ok: false, error: failure }

  const ranges = resolved as Array<{ patch: BlockPatch; from: number; to: number }>
  const targetedIds = new Set<string>()
  for (const range of ranges) {
    for (const blockId of range.patch.targetBlockIds) {
      if (targetedIds.has(blockId)) return { ok: false, error: '多个补丁不能修改同一个目标块。' }
      targetedIds.add(blockId)
    }
  }
  const ordered = [...ranges].sort((left, right) => right.from - left.from)

  for (const item of ordered) {
    const parsed = parseMarkdownDocument(item.patch.after, 'AI 输出')
    const replacement = parsed.content.content ?? [{ type: 'paragraph' }]
    if (item.patch.operation === 'replace') {
      blocks.splice(item.from, item.to - item.from + 1, ...replacement)
    } else if (item.patch.operation === 'insert_before') {
      blocks.splice(item.from, 0, ...replacement)
    } else {
      blocks.splice(item.to + 1, 0, ...replacement)
    }
  }
  content.content = blocks
  const normalized = ensureTopLevelBlockIds(content)
  return { ok: true, content: normalized }
}

function resolvePatchRange(
  blocks: JSONContent[],
  patch: BlockPatch,
): { patch: BlockPatch; from: number; to: number } | string {
  const targetIds = new Set(patch.targetBlockIds)
  const indexes = blocks
    .map((block, index) => (targetIds.has(readBlockId(block)) ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length !== patch.targetBlockIds.length) return '目标块已不存在，需要重新生成。'

  const from = Math.min(...indexes)
  const to = Math.max(...indexes)
  for (let index = from; index <= to; index += 1) {
    if (!targetIds.has(readBlockId(blocks[index] ?? {}))) {
      return '替换补丁的目标块必须连续，已阻止写入。'
    }
  }
  return { patch, from, to }
}

function readBlockId(block: JSONContent): string {
  const attrs = block.attrs
  return attrs && typeof attrs.id === 'string' ? attrs.id : ''
}
