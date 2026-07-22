import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriCognitiveSessionRepository } from '@/infrastructure/database/cognitive/TauriCognitiveSessionRepository'

export async function createCognitiveSessionRepository(): Promise<TauriCognitiveSessionRepository> {
  return new TauriCognitiveSessionRepository(await getDatabase())
}
