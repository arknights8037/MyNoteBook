import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'
import type { AgentToolCall } from '@/models/agentTool'
import type { DocumentId, DocumentRecord } from '@/models/document'
import type { AppResult } from '@/models/result'
import type { ContextBundle } from '@/models/contextBundle'

export interface AgentDocumentTransaction {
  id: string
  taskId: string
  documentId: DocumentId
  beforeRevision: number
  resultingRevision: number
  status: 'applied' | 'rolled_back'
  createdAt: number
  rolledBackAt: number | null
  childDocumentId?: DocumentId | null
}

export interface ApplyAgentPatchSetInput {
  task: AgentTask
  patchSet: AgentPatchSet
  acceptedPatches: BlockPatch[]
  batchId: string
  documents: Array<{
    documentId: DocumentId
    expectedRevision: number
    contentJson: string
    plainText: string
    transactionId: string
  }>
}

export interface AppliedAgentPatchSet {
  document: DocumentRecord | null
  transaction: AgentDocumentTransaction
  documents?: DocumentRecord[]
  transactions?: AgentDocumentTransaction[]
  createdDocuments?: DocumentRecord[]
  removedDocumentIds?: DocumentId[]
}

export interface AgentRecoveryState {
  tasks: AgentTask[]
  pendingTask: AgentTask | null
  pendingPatchSet: AgentPatchSet | null
  lastAppliedTask: AgentTask | null
  lastAppliedPatchSet: AgentPatchSet | null
  lastAppliedTransaction: AgentDocumentTransaction | null
}

export interface ApplyAgentDocumentCreationInput {
  task: AgentTask
  patchSet: AgentPatchSet
  patch: BlockPatch
  contentJson: string
  plainText: string
  transactionId: string
}

export interface ApplyAgentGroupCreationInput {
  task: AgentTask
  patchSet: AgentPatchSet
  patch: BlockPatch
  childContentJson?: string
  childPlainText?: string
  transactionId: string
}

export interface AgentRepository {
  createTask(task: AgentTask): Promise<AppResult<AgentTask>>
  loadRecoveryState(
    documentId: DocumentId,
    options?: { markInterrupted?: boolean },
  ): Promise<AppResult<AgentRecoveryState>>
  savePatchSet(patchSet: AgentPatchSet): Promise<AppResult<AgentPatchSet>>
  updateTask(task: AgentTask): Promise<AppResult<AgentTask>>
  recordToolCall(call: AgentToolCall): Promise<AppResult<AgentToolCall>>
  saveContextBundle(
    bundle: ContextBundle,
    provenance: {
      provider: string
      modelParameters: Record<string, unknown>
      ignoredParameters: string[]
      skillVersions: Array<{ id: string; version: string | null }>
    },
  ): Promise<AppResult<ContextBundle>>
  rejectPatchSet(task: AgentTask, patches: BlockPatch[]): Promise<AppResult<AgentTask>>
  applyPatchSet(input: ApplyAgentPatchSetInput): Promise<AppResult<AppliedAgentPatchSet>>
  applyDocumentCreation(
    input: ApplyAgentDocumentCreationInput,
  ): Promise<AppResult<AppliedAgentPatchSet>>
  applyGroupCreation(input: ApplyAgentGroupCreationInput): Promise<AppResult<AppliedAgentPatchSet>>
  rollbackTransaction(transactionId: string): Promise<AppResult<AppliedAgentPatchSet>>
}
