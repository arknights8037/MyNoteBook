export type DelegateType = 'mcp' | 'cli'
export type DelegationOperation = 'read_context' | 'read_task' | 'submit_artifact' | 'submit_evidence' | 'submit_result' | 'propose_change_set'
export type DelegationStatus = 'pending' | 'accepted' | 'running' | 'submitted' | 'completed' | 'failed' | 'cancelled' | 'expired'

export interface Delegation {
  id: string
  taskRunId: string
  delegateType: DelegateType
  externalActorId: string
  status: DelegationStatus
  contextBundleId: string | null
  allowedOperations: DelegationOperation[]
  expiresAt: number
  correlationId: string
  causationId: string | null
  createdAt: number
  updatedAt: number
}

export interface DelegationGrant {
  delegation: Delegation
  capabilityToken: string
}

export type ExternalSubmission =
  | { type: 'artifact'; entityId: string; artifactType: string; name: string; uri?: string | null; content?: unknown; contentHash?: string | null }
  | { type: 'evidence'; entityId: string; evidenceType: string; status?: 'unverified' | 'valid' | 'invalid'; documentId?: string | null; blockId?: string | null; sourceRevision?: number | null; artifactId?: string | null; claim: string; details?: Record<string, unknown> }
  | { type: 'result'; entityId: string; output: unknown }
  | { type: 'change_set'; entityId: string; title: string; description?: string }

export interface OutboxMessage {
  id: string
  eventId: string
  topic: string
  payload: unknown
  attemptCount: number
  leaseUntil: number
}
