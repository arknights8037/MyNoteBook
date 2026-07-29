export type ApprovalKind =
  | 'execution_authorization'
  | 'mutation_approval'
  | 'external_action_approval'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface AuthorizationRecordInput {
  id: string
  approvalKind: Exclude<ApprovalKind, 'mutation_approval'>
  entityType: 'tool_call' | 'external_action'
  entityId: string
  request: Record<string, unknown>
  runId: string | null
  correlationId: string
  causationId: string | null
  createdAt: number
}
