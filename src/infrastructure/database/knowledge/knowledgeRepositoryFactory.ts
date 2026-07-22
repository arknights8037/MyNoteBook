import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriKnowledgeRepository } from '@/infrastructure/database/knowledge/TauriKnowledgeRepository'

export async function createKnowledgeRepository(): Promise<TauriKnowledgeRepository> {
  return new TauriKnowledgeRepository(await getDatabase())
}
