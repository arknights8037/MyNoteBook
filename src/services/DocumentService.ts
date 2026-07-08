import type {
  CreateDocumentInput,
  DocumentId,
  DocumentRecord,
  DocumentSummary,
  SaveDocumentInput,
  UpdateDocumentInput,
} from '@/models/document'
import type { AppResult } from '@/models/result'
import type { DocumentRepository } from '@/repositories/DocumentRepository'

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
