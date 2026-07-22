export type TaskDefinitionType = 'manual' | 'automation' | 'knowledge'
export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'stale'

const TASK_RUN_TRANSITIONS: Record<TaskRunStatus, readonly TaskRunStatus[]> = {
  queued: ['running', 'cancelled', 'stale'],
  running: [
    'waiting_input',
    'waiting_approval',
    'blocked',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
  ],
  waiting_input: ['running', 'blocked', 'cancelled', 'stale'],
  waiting_approval: ['running', 'waiting_approval', 'completed', 'blocked', 'cancelled', 'stale'],
  blocked: ['running', 'waiting_approval', 'blocked', 'completed', 'cancelled', 'stale'],
  completed: ['stale'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
  timed_out: ['queued', 'cancelled'],
  stale: ['queued', 'cancelled'],
}

export function canTransitionTaskRun(
  currentStatus: TaskRunStatus,
  nextStatus: TaskRunStatus,
): boolean {
  return TASK_RUN_TRANSITIONS[currentStatus].includes(nextStatus)
}

export function getTaskRunTransitionError(
  currentStatus: TaskRunStatus,
  nextStatus: TaskRunStatus,
): string | null {
  return canTransitionTaskRun(currentStatus, nextStatus)
    ? null
    : `不允许从 ${currentStatus} 转换为 ${nextStatus}。`
}

export interface AcceptanceCriteria {
  requiredArtifacts?: Array<{ artifactType: string; minCount?: number }>
  minimumEvidence?: number
  requiredEvidenceTypes?: string[]
  requireValidEvidence?: boolean
  requireTestsPassed?: boolean
  requireApproval?: boolean
  proposeChangeSet?: { title: string; description?: string }
}

export interface TaskDefinition {
  id: string
  definitionType: TaskDefinitionType
  name: string
  instruction: string
  acceptanceCriteria: AcceptanceCriteria
  executionPolicy: Record<string, unknown>
  sourceKnowledgeObjectId: string | null
  automationId: string | null
  enabled: boolean
  version: number
  createdAt: number
  updatedAt: number
}

export interface TaskRun {
  id: string
  taskDefinitionId: string | null
  status: TaskRunStatus
  frozenInput: Record<string, unknown>
  acceptanceCriteria: AcceptanceCriteria
  output: unknown
  error: string | null
  contextBundleId: string | null
  correlationId: string
  causationId: string | null
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface WorkArtifact {
  id: string
  taskRunId: string
  artifactType: string
  name: string
  uri: string | null
  content: unknown
  contentHash: string | null
  createdAt: number
}

export interface WorkEvidence {
  id: string
  taskRunId: string
  evidenceType: string
  status: 'unverified' | 'valid' | 'invalid'
  documentId: string | null
  blockId: string | null
  sourceRevision: number | null
  artifactId: string | null
  claim: string
  details: Record<string, unknown>
  createdAt: number
}

export interface VerificationCheck {
  key: string
  passed: boolean
  verifiable: boolean
  message: string
}

export interface ResultVerification {
  id: string
  taskRunId: string
  verdict: 'passed' | 'failed' | 'needs_approval' | 'unverifiable'
  checks: VerificationCheck[]
  summary: string
  proposedChangeSetId: string | null
  confirmationEnvelope: import('@/models/knowledge/governance').ConfirmationEnvelope
  confirmationHash: string
  correlationId: string
  createdAt: number
}

export interface ChangeSetRecord {
  id: string
  taskRunId: string | null
  agentTaskId: string | null
  status: 'draft' | 'proposed' | 'approved' | 'rejected' | 'applied' | 'rolled_back'
  title: string
  description: string
  patchSetTaskId: string | null
  createdAt: number
  updatedAt: number
}
