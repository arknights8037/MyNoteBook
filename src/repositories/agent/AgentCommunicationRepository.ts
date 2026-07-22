export type AgentCommunicationStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'failed'

export type AgentCommunicationMode = 'agent' | 'research' | 'review' | 'learning'

export interface AgentCommunicationResult {
  version: 1
  outcome: 'proposal' | 'no_change' | 'blocked'
  summary: string
  patchCount: number
  targetDocumentIds: string[]
  cognitive?: {
    mode: Exclude<AgentCommunicationMode, 'agent'>
    result: unknown
    state?: unknown
  }
  finishReason?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
}

export interface AgentCommunicationDecision {
  version: 1
  action: 'approve' | 'reject'
  reply: string
  requestId: string
  taskId: string
  resultVersion: 1 | null
  resultSummary: string
  decidedAt: number
}

export interface AgentCommunicationRequest {
  id: string
  prompt: string
  mode: AgentCommunicationMode
  projectId: string | null
  branchId: string | null
  branchTitle: string | null
  parentConversationId: string | null
  status: AgentCommunicationStatus
  taskId: string | null
  previousTaskId: string | null
  revisionFeedback: string | null
  revisionCount: number
  result: AgentCommunicationResult | null
  decision: AgentCommunicationDecision | null
}

export interface AgentCommunicationRepository {
  claimNext(): Promise<AgentCommunicationRequest | null>
  claimRevisionForTask(taskId: string): Promise<AgentCommunicationRequest | null>
  findDecisionForTask(taskId: string): Promise<AgentCommunicationRequest | null>
  findFailedForTask(taskId: string): Promise<AgentCommunicationRequest | null>
  listRecentCompleted(limit?: number): Promise<AgentCommunicationRequest[]>
  markAwaitingReview(id: string, taskId: string, result: AgentCommunicationResult): Promise<void>
  markCompleted(
    id: string,
    taskId: string | null,
    result?: AgentCommunicationResult | null,
  ): Promise<void>
  markFailed(id: string, taskId: string | null, error: string): Promise<void>
}
