import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriWorkRepository } from '@/infrastructure/database/knowledge/TauriWorkRepository'

export async function createWorkRepository(): Promise<TauriWorkRepository> {
  return new TauriWorkRepository(await getDatabase())
}
