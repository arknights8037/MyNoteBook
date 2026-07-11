import { TauriAgentRepository } from './TauriAgentRepository'
import { getDatabase } from './connection'
import type { AgentRepository } from '@/repositories/AgentRepository'

export async function createAgentRepository(): Promise<AgentRepository> {
  return new TauriAgentRepository(await getDatabase())
}
