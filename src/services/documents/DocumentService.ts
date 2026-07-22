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
import type { DocumentRepository } from '@/repositories/documents/DocumentRepository'

export class DocumentService {
  constructor(private readonly documentRepository: DocumentRepository) {}

  createDocument(input: CreateDocumentInput): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.create(input)
  }

  getDocument(id: DocumentId): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.findById(id)
  }

  listRootDocuments(): Promise<AppResult<DocumentSummary[]>> {
    return this.documentRepository.listByParent(null)
  }

  listRecentDocuments(limit = 50): Promise<AppResult<DocumentSummary[]>> {
    return this.documentRepository.listRecent({ limit })
  }

  listDeletedDocuments(limit = 50): Promise<AppResult<DocumentSummary[]>> {
    return this.documentRepository.listDeleted({ limit })
  }

  searchKnowledgeDocuments(query: string, limit = 5): Promise<AppResult<DocumentSummary[]>> {
    return this.documentRepository.searchKnowledge(query, { limit })
  }

  listDocumentBlocks(documentId: DocumentId): Promise<AppResult<DocumentBlock[]>> {
    return this.documentRepository.listBlocks(documentId)
  }

  updateDocument(input: UpdateDocumentInput): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.update(input)
  }

  saveDocument(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.save(input)
  }

  deleteDocument(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.softDelete(id, expectedRevision)
  }

  restoreDocument(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.restore(id, expectedRevision)
  }

  permanentlyDeleteDocument(
    id: DocumentId,
    expectedRevision: number,
  ): Promise<AppResult<DocumentRecord>> {
    return this.documentRepository.hardDelete(id, expectedRevision)
  }
}
