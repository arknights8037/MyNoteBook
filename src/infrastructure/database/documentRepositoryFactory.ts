import { TauriDocumentRepository } from './TauriDocumentRepository'
import { getDatabase } from './connection'
import type { DocumentRepository } from '@/repositories/DocumentRepository'

export async function createDocumentRepository(): Promise<DocumentRepository> {
  return new TauriDocumentRepository(await getDatabase())
}

