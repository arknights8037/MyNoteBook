import type { Ref } from 'vue'

import type { AiConversationMessage } from '../useAiConversation'
import type { AgentPatchSet, AgentTask, SelectedBlock } from '@/models/agent'
import type { AiSettings } from '@/models/ai'
import type { AiChatMode } from '@/models/aiChatMode'
import type { DocumentBlock } from '@/models/documentBlock'
import type { DocumentRecord, DocumentSummary } from '@/models/document'
import type { AgentRepository } from '@/repositories/AgentRepository'
import type { RegexReplaceExecutor } from '@/services/AgentCommandService'

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
  document: AgentRunDocumentAdapter
  patches: AgentRunPatchWorkflow
  workspace?: {
    projectId: Readonly<Ref<string>>
    projectName: Readonly<Ref<string>>
    rootDocumentIds: Readonly<Ref<string[]>>
    conversationId: Readonly<Ref<string | null>>
    ensureConversationId: () => string
  }
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
  workspace?: {
    projectId: string
    projectName: string
    rootDocumentIds: string[]
    conversationId: string
  }
}
