import type { Ref } from 'vue'

import type { AiConversationMessage } from '../useAiConversation'
import type { AgentPatchSet, AgentTask, SelectedBlock } from '@/models/agent/agent'
import type { AiSettings } from '@/models/ai/ai'
import type { AiChatMode } from '@/models/ai/aiChatMode'
import type { DocumentBlock } from '@/models/documents/documentBlock'
import type { DocumentRecord, DocumentSummary } from '@/models/documents/document'
import type { AgentRepository } from '@/repositories/agent/AgentRepository'
import type { RegexReplaceExecutor } from '@/services/agent/AgentCommandService'
import type { CognitiveSessionService } from '@/services/cognitive/CognitiveSessionService'
import type { AgentExplicitTarget } from '@/models/agent/agentTarget'
import type { KnowledgeRepository } from '@/repositories/knowledge/KnowledgeRepository'
import type { AgentResourceDraftService } from '@/services/agent/AgentResourceDraftService'
import type { MindMapService } from '@/services/workspace/MindMapService'
import type { ResearchCandidateService } from '@/services/cognitive/ResearchCandidateService'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'
import type { McpClientPort } from '@/services/ports/McpClientPort'

export interface AgentRunServiceDependencies {
  getCognitiveSessionService?: () => Promise<CognitiveSessionService>
  getMindMapService?: () => Promise<MindMapService>
  getKnowledgeRepository?: () => Promise<KnowledgeRepository>
  getAgentResourceDraftService?: () => Promise<AgentResourceDraftService>
  getResearchCandidateService?: () => Promise<ResearchCandidateService>
  getAgentRepository?: () => Promise<AgentRepository>
  agentWorkspaceHistoryStore?: AgentWorkspaceHistoryStore
  mcpClient?: McpClientPort
}

export interface AgentRunDocumentSnapshot {
  id: string
  title: string
  tags: string[]
  sourceUrl: string
  author: string
  text: string
  markdown: string
  revision: number | null
  blocks: SelectedBlock[]
  selectedBlocks: SelectedBlock[]
  hasBlockSelection: boolean
  documents: DocumentSummary[]
}
export interface AgentRunDocumentAdapter {
  captureSnapshot: () => AgentRunDocumentSnapshot
  flushBeforeEdit: () => Promise<{ ok: boolean; revision?: number | null }>
  searchDocuments: (query: string, limit: number) => Promise<DocumentSummary[]>
  readDocument: (documentId: string) => Promise<DocumentRecord | null>
  listDocumentBlocks: (documentId: string) => Promise<DocumentBlock[]>
  openDocumentForReview: (documentId: string) => Promise<void>
}

export interface AgentRunPatchWorkflow {
  pendingTask: Ref<AgentTask | null>
  pendingPatchSet: Ref<AgentPatchSet | null>
  showModal: Ref<boolean>
  getRepository: () => Promise<AgentRepository>
  updateTaskPersistence: (task: AgentTask) => Promise<void>
}

export interface UseAgentRunOptions {
  settings: Ref<AiSettings>
  mode: Ref<AiChatMode>
  prompt: Ref<string>
  messages: Ref<AiConversationMessage[]>
  error: Ref<string>
  isRunning: Ref<boolean>
  tasks: Ref<AgentTask[]>
  ensureSecretLoaded: () => Promise<boolean>
  createId: () => string
  replaceBlocksByRegex: RegexReplaceExecutor
  notify: { success: (message: string) => void; error: (message: string) => void }
  services?: AgentRunServiceDependencies
  document: AgentRunDocumentAdapter
  patches: AgentRunPatchWorkflow
  explicitTargets?: Readonly<Ref<AgentExplicitTarget[]>>
  workspace?: {
    projectId: Readonly<Ref<string>>
    projectName: Readonly<Ref<string>>
    rootDocumentIds: Readonly<Ref<string[]>>
    conversationId: Readonly<Ref<string | null>>
    ensureConversationId: () => string
    requestConversationTitle?: (conversationId: string, prompt: string) => void
  }
}

export interface AgentRunSession {
  mode: Ref<AiChatMode>
  prompt: Ref<string>
  messages: Ref<AiConversationMessage[]>
  error: Ref<string>
  documentSnapshot?: AgentRunDocumentSnapshot
  explicitTargets?: Readonly<Ref<AgentExplicitTarget[]>>
  background?: boolean
  workspace?: UseAgentRunOptions['workspace']
}

export interface AgentRunContinuation {
  previousTaskId: string
  feedback: string
  previousSummary: string
  patches: BlockPatch[]
}

export interface AgentRunSnapshot {
  prompt: string
  requestedMode: AiChatMode
  settings: AiSettings
  document: AgentRunDocumentSnapshot
  explicitTargets: AgentExplicitTarget[]
  workspace?: {
    projectId: string
    projectName: string
    rootDocumentIds: string[]
    conversationId: string
  }
}
