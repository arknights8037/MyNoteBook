import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriViewRepository } from '@/infrastructure/database/knowledge/TauriViewRepository'

export async function createViewRepository(): Promise<TauriViewRepository> {
  return new TauriViewRepository(await getDatabase())
}
