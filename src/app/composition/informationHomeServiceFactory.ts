import { createInformationHomeRepository } from '@/infrastructure/database/home/informationHomeRepositoryFactory'
import { createEntityId } from '@/models/shared/id'
import { InformationHomeService } from '@/services/home/InformationHomeService'

export async function createInformationHomeService() {
  return new InformationHomeService(
    await createInformationHomeRepository(),
    createEntityId,
    async (input) =>
      (await import('@/services/ai/AiMarkdownService')).runAiMarkdownCompletion(input),
    Date.now,
  )
}
