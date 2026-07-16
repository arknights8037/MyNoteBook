import { getDatabase } from './connection'
import { TauriMindMapRepository } from './TauriMindMapRepository'

export async function createMindMapRepository(): Promise<TauriMindMapRepository> {
  return new TauriMindMapRepository(await getDatabase())
}
