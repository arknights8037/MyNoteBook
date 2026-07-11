import type { DocumentId } from './document'

/** Read-only projection; documents.content_json remains the write source of truth. */
export interface DocumentBlock {
  id: string
  documentId: DocumentId
  type: string
  index: number
  contentJson: string
  plainText: string
  documentRevision: number
  updatedAt: number
}
