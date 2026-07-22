import { TauriAgentRepository } from '@/infrastructure/database/agent/TauriAgentRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'
import type { AgentRepository } from '@/repositories/agent/AgentRepository'

export async function createAgentRepository(): Promise<AgentRepository> {
  return new TauriAgentRepository(await getDatabase())
}
