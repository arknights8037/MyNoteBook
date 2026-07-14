import { TauriGovernanceRepository } from './TauriGovernanceRepository'
import { getDatabase } from './connection'

export async function createGovernanceRepository(): Promise<TauriGovernanceRepository> {
  return new TauriGovernanceRepository(await getDatabase())
}
