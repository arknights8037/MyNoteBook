import { createCognitiveSessionRepository } from '@/infrastructure/database/cognitive/cognitiveSessionRepositoryFactory'
import { CognitiveSessionService } from '@/services/cognitive/CognitiveSessionService'

export async function createCognitiveSessionService(): Promise<CognitiveSessionService> {
  return new CognitiveSessionService(await createCognitiveSessionRepository())
}
