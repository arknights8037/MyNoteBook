import { createAgentCommunicationRepository } from '@/infrastructure/database/agent/agentCommunicationRepositoryFactory'
import { AgentCommunicationService } from '@/services/agent/AgentCommunicationService'

export async function createAgentCommunicationService(): Promise<AgentCommunicationService> {
  return new AgentCommunicationService(await createAgentCommunicationRepository())
}

export function createAgentCommunicationServiceProvider(): () => Promise<AgentCommunicationService> {
  let service: Promise<AgentCommunicationService> | null = null
  return () => (service ??= createAgentCommunicationService())
}
