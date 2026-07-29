import { createRssRepository } from '@/infrastructure/database/inbox/rssRepositoryFactory'
import { createEntityId } from '@/models/shared/id'
import { RssService } from '@/services/inbox/RssService'

export async function createRssService(): Promise<RssService> {
  return new RssService(await createRssRepository(), createEntityId, Date.now)
}
