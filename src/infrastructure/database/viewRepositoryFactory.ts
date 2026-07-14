import { getDatabase } from './connection'
import { TauriViewRepository } from './TauriViewRepository'

export async function createViewRepository(): Promise<TauriViewRepository> {
  return new TauriViewRepository(await getDatabase())
}
