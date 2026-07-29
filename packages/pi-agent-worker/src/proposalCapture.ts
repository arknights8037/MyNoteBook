import type { PiAgentPatchProposal, PiDocumentEditProposal } from './types.js'

export function parseDocumentEditProposal(value: unknown): PiDocumentEditProposal {
  if (!isRecord(value) || !Array.isArray(value.documents) || value.documents.length === 0) {
    throw new Error('submit_document_edits.documents 必须包含至少一个文档。')
  }
  const summary = requiredString(value.summary, 'submit_document_edits.summary')
  const documentIds = new Set<string>()
  const targets = new Set<string>()
  const documents = value.documents.map((document, documentIndex) => {
    if (!isRecord(document) || !Array.isArray(document.edits) || document.edits.length === 0) {
      throw new Error(`submit_document_edits.documents[${documentIndex}].edits 不能为空。`)
    }
    const documentId = requiredString(
      document.documentId,
      `submit_document_edits.documents[${documentIndex}].documentId`,
    )
    if (documentIds.has(documentId)) throw new Error('同一文档只能提交一次修改提案。')
    documentIds.add(documentId)
    const edits = document.edits.map((edit, editIndex) => {
      if (!isRecord(edit)) throw new Error(`documents[${documentIndex}].edits[${editIndex}] 无效。`)
      const content = requiredString(edit.content, 'edit.content')
      const reason = requiredString(edit.reason, 'edit.reason')
      if (edit.kind === 'replace') {
        const targetBlockIds = requiredUniqueStrings(edit.targetBlockIds, 'edit.targetBlockIds')
        claimTargets(targets, documentId, targetBlockIds)
        return { kind: 'replace' as const, targetBlockIds, content, reason }
      }
      if (edit.kind === 'insert_before' || edit.kind === 'insert_after' || edit.kind === 'append') {
        const anchorBlockId = requiredString(edit.anchorBlockId, 'edit.anchorBlockId')
        claimTargets(targets, documentId, [anchorBlockId])
        return {
          kind: edit.kind as 'insert_before' | 'insert_after' | 'append',
          anchorBlockId,
          content,
          reason,
        }
      }
      throw new Error(`不支持的文档修改类型：${String(edit.kind)}`)
    })
    return { documentId, edits }
  })
  return { summary, documents }
}

export function toAgentPatchProposals(proposal: PiDocumentEditProposal): PiAgentPatchProposal[] {
  return proposal.documents.flatMap((document) =>
    document.edits.map((edit) => {
      const targetBlockIds =
        edit.kind === 'replace' ? [...edit.targetBlockIds] : [edit.anchorBlockId]
      return {
        documentId: document.documentId,
        operation: edit.kind,
        blockId: targetBlockIds[0] ?? '',
        targetBlockIds,
        after: edit.content,
        reason: edit.reason,
      }
    }),
  )
}

function claimTargets(targets: Set<string>, documentId: string, blockIds: string[]): void {
  for (const blockId of blockIds) {
    const key = `${documentId}:${blockId}`
    if (targets.has(key)) throw new Error('同一批 Patch 不能重复修改或锚定同一个块。')
    targets.add(key)
  }
}

function requiredUniqueStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} 不能为空。`)
  const strings = value.map((item) => requiredString(item, path))
  if (new Set(strings).size !== strings.length) throw new Error(`${path} 不能包含重复块。`)
  return strings
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} 不能为空。`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
