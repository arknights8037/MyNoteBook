import { createCognitiveSessionRepository } from '@/infrastructure/database/cognitiveSessionRepositoryFactory'
import { CognitiveSessionService } from '@/services/CognitiveSessionService'

export async function createCognitiveSessionService(): Promise<CognitiveSessionService> {
  return new CognitiveSessionService(await createCognitiveSessionRepository())
}
