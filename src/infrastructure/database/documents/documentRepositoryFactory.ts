import { TauriDocumentRepository } from '@/infrastructure/database/documents/TauriDocumentRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'
import type { DocumentRepository } from '@/repositories/documents/DocumentRepository'

export async function createDocumentRepository(): Promise<DocumentRepository> {
  return new TauriDocumentRepository(await getDatabase())
}

