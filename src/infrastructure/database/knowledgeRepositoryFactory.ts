import { getDatabase } from './connection'
import { TauriKnowledgeRepository } from './TauriKnowledgeRepository'

export async function createKnowledgeRepository(): Promise<TauriKnowledgeRepository> {
  return new TauriKnowledgeRepository(await getDatabase())
}
