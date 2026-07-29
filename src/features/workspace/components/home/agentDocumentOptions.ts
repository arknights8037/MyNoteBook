import type { AgentTargetOption } from '@/models/agent/agentTarget'
import type { DocumentId, DocumentSummary } from '@/models/documents/document'
import { displayDocumentTitle } from '@/models/documents/documentPresentation'
import { collectDocumentAncestors, isDocumentDescendantOf } from '@/models/documents/documentTree'

export interface AgentWorkspaceOption {
  label: string
  value: DocumentId
  searchText: string
}

export function buildAgentWorkspaceOptions(documents: DocumentSummary[]): AgentWorkspaceOption[] {
  const documentById = new Map(documents.map((document) => [document.id, document]))
  const activeArticles = documents.filter(
    (document) => document.documentKind === 'article' && !document.isDeleted,
  )

  return documents
    .filter((document) => document.documentKind === 'group' && !document.isDeleted)
    .map((group) => ({
      label: displayDocumentTitle(group),
      value: group.id,
      searchText: [
        group.description,
        group.tags.join(' '),
        ...activeArticles
          .filter((document) => isDocumentDescendantOf(document, group.id, documentById))
          .map(displayDocumentTitle),
      ]
        .filter(Boolean)
        .join(' '),
    }))
}

export function buildAgentTargetOptions(
  documents: DocumentSummary[],
  activeDocumentId: DocumentId,
): AgentTargetOption[] {
  const documentById = new Map(documents.map((document) => [document.id, document]))
  return documents
    .filter((document) => document.documentKind === 'article' && !document.isDeleted)
    .map((document) => {
      const groupPath = collectDocumentAncestors(document, documentById)
        .filter((ancestor) => ancestor.documentKind === 'group')
        .reverse()
        .map(displayDocumentTitle)
        .join(' / ')
      return {
        kind: 'document',
        id: document.id,
        title: displayDocumentTitle(document),
        subtitle: [groupPath, document.id === activeDocumentId ? '当前页面' : '知识库页面']
          .filter(Boolean)
          .join(' · '),
      }
    })
}
