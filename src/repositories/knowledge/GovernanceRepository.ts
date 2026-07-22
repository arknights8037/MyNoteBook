import type { AppResult } from '@/models/shared/result'
import type { ContextBundle } from '@/models/agent/contextBundle'
import type { DelegateType, Delegation, DelegationOperation, ExternalSubmission, OutboxMessage } from '@/models/knowledge/governance'

export interface GovernanceRepository {
  createDelegation(input: {
    id: string
    taskRunId: string
    delegateType: DelegateType
    externalActorId: string
    contextBundleId?: string | null
    capabilityTokenHash: string
    allowedOperations: DelegationOperation[]
    expiresAt: number
    correlationId: string
    causationId?: string | null
    createdAt: number
  }): Promise<AppResult<Delegation>>
  getDelegation(id: string): Promise<AppResult<Delegation>>
  getContextBundle(id: string): Promise<AppResult<ContextBundle>>
  submitExternal(input: {
    delegationId: string
    capabilityTokenHash: string
    idempotencyKey: string
    requestHash: string
    submission: ExternalSubmission
    submittedAt: number
  }): Promise<AppResult<{ entityId: string; replayed: boolean }>>
  claimOutbox(input: { workerId: string; now: number; leaseMs: number; limit: number }): Promise<AppResult<OutboxMessage[]>>
  settleOutbox(input: { id: string; workerId: string; published: boolean; error?: string | null; now: number; retryAt?: number | null }): Promise<AppResult<void>>
}
