import type { DocumentId, DocumentRecord, DocumentSummary } from '@/models/documents/document'

const DOCUMENT_LIST_LIMIT = 200

export interface DocumentLists {
  active: DocumentSummary[]
  deleted: DocumentSummary[]
}

export function documentRecordToSummary(document: DocumentRecord): DocumentSummary {
  return {
    id: document.id,
    parentId: document.parentId,
    documentKind: document.documentKind,
    title: document.title,
    tags: document.tags,
    sourceUrl: document.sourceUrl,
    author: document.author,
    description: document.description,
    plainText: document.plainText,
    characterCount: Array.from(document.plainText.trim()).length,
    revision: document.revision,
    sortOrder: document.sortOrder,
    isDeleted: document.isDeleted,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

export function mergeDocumentRecord(lists: DocumentLists, document: DocumentRecord): DocumentLists {
  const summary = documentRecordToSummary(document)
  return document.isDeleted
    ? {
        active: removeDocumentSummaries(lists.active, [document.id]),
        deleted: upsertDocumentSummary(lists.deleted, summary, 'recent'),
      }
    : {
        active: upsertDocumentSummary(lists.active, summary, 'stable'),
        deleted: removeDocumentSummaries(lists.deleted, [document.id]),
      }
}

export function removeDocumentSummaries(
  documents: DocumentSummary[],
  documentIds: Iterable<DocumentId>,
): DocumentSummary[] {
  const ids = new Set(documentIds)
  return documents.filter((document) => !ids.has(document.id))
}

function upsertDocumentSummary(
  documents: DocumentSummary[],
  document: DocumentSummary,
  ordering: 'stable' | 'recent',
): DocumentSummary[] {
  const nextDocuments = [document, ...documents.filter((candidate) => candidate.id !== document.id)]
  return nextDocuments
    .sort(ordering === 'stable' ? compareStablePosition : compareRecent)
    .slice(0, DOCUMENT_LIST_LIMIT)
}

function compareStablePosition(left: DocumentSummary, right: DocumentSummary): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  )
}

function compareRecent(left: DocumentSummary, right: DocumentSummary): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
}
