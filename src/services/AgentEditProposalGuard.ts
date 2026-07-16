import type { SelectedBlock } from '@/models/agent'
import { parseMarkdownDocument } from '@/editor/markdownImport'

export type AgentDocumentEdit =
  | {
      kind: 'replace'
      targetBlockIds: string[]
      content: string
      reason: string
    }
  | {
      kind: 'insert_before' | 'insert_after' | 'append'
      anchorBlockId: string
      content: string
      reason: string
    }

export interface AgentDocumentEditProposal {
  documents: Array<{ documentId: string; edits: AgentDocumentEdit[] }>
  summary: string
}

export interface AgentReadableDocument {
  documentId: string
  documentTitle: string
  expectedVersion: number
  blocks: SelectedBlock[]
}

export function parseReadDocumentProvenance(
  value: unknown,
  expectedDocumentId: string,
): AgentReadableDocument | null {
  if (!isRecord(value) || value.id !== expectedDocumentId || typeof value.title !== 'string') {
    return null
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1 || !Array.isArray(value.blocks)) {
    return null
  }
  const blocks: SelectedBlock[] = []
  const ids = new Set<string>()
  for (const item of value.blocks) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      ids.has(item.id) ||
      typeof item.blockType !== 'string' ||
      typeof item.plainText !== 'string' ||
      !Number.isInteger(item.blockIndex)
    ) {
      return null
    }
    ids.add(item.id)
    blocks.push({
      id: item.id,
      type: item.blockType,
      text: item.plainText,
      ...(typeof item.markdown === 'string' ? { markdown: item.markdown } : {}),
      index: item.blockIndex as number,
    })
  }
  return {
    documentId: expectedDocumentId,
    documentTitle: value.title,
    expectedVersion: value.revision as number,
    blocks,
  }
}

export function validateDocumentEditProvenance(
  proposal: AgentDocumentEditProposal,
  readableDocuments: readonly AgentReadableDocument[],
): void {
  const readableById = new Map(readableDocuments.map((document) => [document.documentId, document]))
  for (const document of proposal.documents) {
    const readable = readableById.get(document.documentId)
    if (!readable) {
      throw new Error(
        `文档 ${document.documentId} 尚未通过本次 read_document 成功读取；请先读取后重新提交完整提案。`,
      )
    }
    const blocksById = new Map(readable.blocks.map((block) => [block.id, block]))
    for (const edit of document.edits) {
      const targetIds = edit.kind === 'replace' ? edit.targetBlockIds : [edit.anchorBlockId]
      const missing = targetIds.filter((blockId) => !blocksById.has(blockId))
      if (missing.length > 0) {
        throw new Error(
          `文档 ${document.documentId} 的目标块不属于本次 read_document 返回结果：${missing.join(', ')}。请使用读取结果中的真实 block id 重新提交完整提案。`,
        )
      }
      if (edit.kind === 'replace') {
        const targetBlocks = edit.targetBlockIds.map((blockId) => blocksById.get(blockId)!)
        if (targetBlocks.length === 1 && targetBlocks[0]?.type === 'tableBlock') {
          const parsedBlocks = parseMarkdownDocument(edit.content, 'Agent table edit').content.content ?? []
          if (parsedBlocks.length !== 1 || parsedBlocks[0]?.type !== 'tableBlock') {
            throw new Error(
              `文档 ${document.documentId} 的 tableBlock 必须使用 Markdown pipe table 完整替换；TSV、空格对齐文本或普通段落不保留表格结构。`,
            )
          }
        }
        const before = edit.targetBlockIds
          .map((blockId) => blocksById.get(blockId)?.text ?? '')
          .join('\n\n')
        const structuralBefore =
          targetBlocks.length === 1 && targetBlocks[0]?.markdown
            ? targetBlocks[0].markdown
            : before
        if (normalizeText(structuralBefore) === normalizeText(edit.content)) {
          throw new Error(
            `文档 ${document.documentId} 的 replace 内容与 canonical 目标块相同；请删除 no-op edit 后重新提交完整提案。`,
          )
        }
      }
    }
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
