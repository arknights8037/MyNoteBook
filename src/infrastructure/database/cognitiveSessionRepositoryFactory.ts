import { getDatabase } from './connection'
import { TauriCognitiveSessionRepository } from './TauriCognitiveSessionRepository'

export async function createCognitiveSessionRepository(): Promise<TauriCognitiveSessionRepository> {
  return new TauriCognitiveSessionRepository(await getDatabase())
}
