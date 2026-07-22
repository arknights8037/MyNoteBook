import { TauriGovernanceRepository } from '@/infrastructure/database/knowledge/TauriGovernanceRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'

export async function createGovernanceRepository(): Promise<TauriGovernanceRepository> {
  return new TauriGovernanceRepository(await getDatabase())
}
