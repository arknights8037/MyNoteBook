import type { AgentCommunicationRepository } from '@/repositories/agent/AgentCommunicationRepository'
import { getDatabase } from '@/infrastructure/database/shared/connection'
import { TauriAgentCommunicationRepository } from '@/infrastructure/database/agent/TauriAgentCommunicationRepository'

export async function createAgentCommunicationRepository(): Promise<AgentCommunicationRepository> {
  return new TauriAgentCommunicationRepository(await getDatabase())
}
