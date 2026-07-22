import { createAgentResourceDraftService } from './agentResourceDraftServiceFactory'
import { createCognitiveSessionService } from './cognitiveSessionServiceFactory'
import { createMindMapService } from './mindMapServiceFactory'
import { createResearchCandidateService } from './researchCandidateServiceFactory'
import { createWorkspaceViewService } from './workspaceViewServiceFactory'
import { createKnowledgeRepository } from '@/infrastructure/database/knowledge/knowledgeRepositoryFactory'
import { createAgentRepository } from '@/infrastructure/database/agent/agentRepositoryFactory'
import { createAgentWorkspaceHistoryStore } from '@/infrastructure/database/agent/AgentWorkspaceHistoryStore'
import { createEntityId } from '@/models/shared/id'
import type { KnowledgeRepository } from '@/repositories/knowledge/KnowledgeRepository'
import type { AgentRepository } from '@/repositories/agent/AgentRepository'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'
import type { AgentResourceDraftService } from '@/services/agent/AgentResourceDraftService'
import type { CognitiveSessionService } from '@/services/cognitive/CognitiveSessionService'
import type { MindMapService } from '@/services/workspace/MindMapService'
import type { ResearchCandidateService } from '@/services/cognitive/ResearchCandidateService'
import type { WorkspaceViewService } from '@/services/workspace/WorkspaceViewService'
import type { McpClientPort } from '@/services/ports/McpClientPort'

export interface WorkspaceServiceProviders {
  getCognitiveSessionService: () => Promise<CognitiveSessionService>
  getMindMapService: () => Promise<MindMapService>
  getKnowledgeRepository: () => Promise<KnowledgeRepository>
  getAgentResourceDraftService: () => Promise<AgentResourceDraftService>
  getResearchCandidateService: () => Promise<ResearchCandidateService>
  getWorkspaceViewService: () => Promise<WorkspaceViewService>
  getAgentRepository: () => Promise<AgentRepository>
  agentWorkspaceHistoryStore: AgentWorkspaceHistoryStore
  mcpClient: McpClientPort
}

export function createWorkspaceServiceProviders(mcpClient: McpClientPort): WorkspaceServiceProviders {
  return {
    getCognitiveSessionService: lazyProvider(createCognitiveSessionService),
    getMindMapService: lazyProvider(createMindMapService),
    getKnowledgeRepository: lazyProvider(createKnowledgeRepository),
    getAgentResourceDraftService: lazyProvider(() =>
      createAgentResourceDraftService(createEntityId, mcpClient),
    ),
    getResearchCandidateService: lazyProvider(() => createResearchCandidateService(createEntityId)),
    getWorkspaceViewService: lazyProvider(createWorkspaceViewService),
    getAgentRepository: lazyProvider(createAgentRepository),
    agentWorkspaceHistoryStore: createAgentWorkspaceHistoryStore(),
    mcpClient,
  }
}

function lazyProvider<T>(factory: () => Promise<T>): () => Promise<T> {
  let instance: Promise<T> | null = null
  return () => (instance ??= factory())
}
