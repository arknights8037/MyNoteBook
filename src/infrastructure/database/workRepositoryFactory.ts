import { getDatabase } from './connection'
import { TauriWorkRepository } from './TauriWorkRepository'

export async function createWorkRepository(): Promise<TauriWorkRepository> {
  return new TauriWorkRepository(await getDatabase())
}
