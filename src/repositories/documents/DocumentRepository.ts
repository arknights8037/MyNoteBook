import type {
  CreateDocumentInput,
  DocumentId,
  DocumentRecord,
  DocumentSummary,
  SaveDocumentInput,
  UpdateDocumentInput,
} from '@/models/documents/document'
import type { AppResult } from '@/models/shared/result'
import type { DocumentBlock } from '@/models/documents/documentBlock'

export interface DocumentRepository {
  create(input: CreateDocumentInput): Promise<AppResult<DocumentRecord>>
  findById(
    id: DocumentId,
    options?: { includeDeleted?: boolean },
  ): Promise<AppResult<DocumentRecord>>
  listByParent(
    parentId: DocumentId | null,
    options?: { includeDeleted?: boolean },
  ): Promise<AppResult<DocumentSummary[]>>
  listRecent(options?: {
    includeDeleted?: boolean
    limit?: number
  }): Promise<AppResult<DocumentSummary[]>>
  listDeleted(options?: { limit?: number }): Promise<AppResult<DocumentSummary[]>>
  searchKnowledge(
    query: string,
    options?: { limit?: number },
  ): Promise<AppResult<DocumentSummary[]>>
  listBlocks(documentId: DocumentId): Promise<AppResult<DocumentBlock[]>>
  update(input: UpdateDocumentInput): Promise<AppResult<DocumentRecord>>
  save(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>>
  softDelete(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>>
  restore(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>>
  hardDelete(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>>
}
