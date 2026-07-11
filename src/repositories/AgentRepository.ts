import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'
import type { AgentToolCall } from '@/models/agentTool'
import type { DocumentId, DocumentRecord } from '@/models/document'
import type { AppResult } from '@/models/result'

export interface AgentDocumentTransaction {
  id: string
  taskId: string
  documentId: DocumentId
  beforeRevision: number
  resultingRevision: number
  status: 'applied' | 'rolled_back'
  createdAt: number
  rolledBackAt: number | null
}

export interface ApplyAgentPatchSetInput {
  task: AgentTask
  patchSet: AgentPatchSet
  acceptedPatches: BlockPatch[]
  contentJson: string
  plainText: string
  transactionId: string
}

export interface AppliedAgentPatchSet {
  document: DocumentRecord | null
  transaction: AgentDocumentTransaction
}

export interface ApplyAgentDocumentCreationInput {
  task: AgentTask
  patchSet: AgentPatchSet
  patch: BlockPatch
  contentJson: string
  plainText: string
  transactionId: string
}

export interface AgentRepository {
  createTask(task: AgentTask): Promise<AppResult<AgentTask>>
  savePatchSet(patchSet: AgentPatchSet): Promise<AppResult<AgentPatchSet>>
  updateTask(task: AgentTask): Promise<AppResult<AgentTask>>
  recordToolCall(call: AgentToolCall): Promise<AppResult<AgentToolCall>>
  rejectPatchSet(task: AgentTask, patches: BlockPatch[]): Promise<AppResult<AgentTask>>
  applyPatchSet(input: ApplyAgentPatchSetInput): Promise<AppResult<AppliedAgentPatchSet>>
  applyDocumentCreation(
    input: ApplyAgentDocumentCreationInput,
  ): Promise<AppResult<AppliedAgentPatchSet>>
  rollbackTransaction(transactionId: string): Promise<AppResult<AppliedAgentPatchSet>>
}
