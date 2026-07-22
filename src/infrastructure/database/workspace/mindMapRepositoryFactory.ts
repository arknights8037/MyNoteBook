import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriMindMapRepository } from '@/infrastructure/database/workspace/TauriMindMapRepository'

export async function createMindMapRepository(): Promise<TauriMindMapRepository> {
  return new TauriMindMapRepository(await getDatabase())
}
