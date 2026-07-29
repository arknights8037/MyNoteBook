import { TauriRssRepository } from '@/infrastructure/database/inbox/TauriRssRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'

export async function createRssRepository(): Promise<TauriRssRepository> {
  return new TauriRssRepository(await getDatabase())
}
