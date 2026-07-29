import { TauriImRepository } from '@/infrastructure/database/inbox/TauriImRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'

export async function createImRepository(): Promise<TauriImRepository> {
  return new TauriImRepository(await getDatabase())
}
