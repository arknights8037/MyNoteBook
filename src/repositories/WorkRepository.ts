import type {
  AcceptanceCriteria,
  ChangeSetRecord,
  ResultVerification,
  TaskDefinition,
  TaskDefinitionType,
  TaskRun,
  TaskRunStatus,
  WorkArtifact,
  WorkEvidence,
} from '@/models/work'
import type { AppResult } from '@/models/result'

export interface WorkRepository {
  createDefinition(input: {
    id: string
    definitionType: TaskDefinitionType
    name: string
    instruction: string
    acceptanceCriteria?: AcceptanceCriteria
    executionPolicy?: Record<string, unknown>
    sourceKnowledgeObjectId?: string | null
    enabled?: boolean
    createdAt?: number
  }): Promise<AppResult<TaskDefinition>>
  createRun(input: {
    id: string
    taskDefinitionId?: string | null
    frozenInput?: Record<string, unknown>
    acceptanceCriteria?: AcceptanceCriteria
    correlationId?: string
    causationId?: string | null
    queuedAt?: number
  }): Promise<AppResult<TaskRun>>
  getRun(id: string): Promise<AppResult<TaskRun>>
  listRuns(limit?: number): Promise<AppResult<TaskRun[]>>
  updateRunStatus(input: {
    id: string
    expectedStatus: TaskRunStatus
    status: TaskRunStatus
    output?: unknown
    error?: string | null
    startedAt?: number | null
    completedAt?: number | null
  }): Promise<AppResult<TaskRun>>
  addArtifact(artifact: WorkArtifact): Promise<AppResult<WorkArtifact>>
  listArtifacts(taskRunId: string): Promise<AppResult<WorkArtifact[]>>
  addEvidence(evidence: WorkEvidence): Promise<AppResult<WorkEvidence>>
  listEvidence(taskRunId: string): Promise<AppResult<WorkEvidence[]>>
  finalizeVerification(input: {
    verification: ResultVerification
    proposedChangeSet: ChangeSetRecord | null
    expectedStatus: TaskRunStatus
    nextStatus: TaskRunStatus
  }): Promise<AppResult<ResultVerification>>
  createChangeSet(changeSet: ChangeSetRecord): Promise<AppResult<ChangeSetRecord>>
  decideChangeSet(input: {
    changeSetId: string
    decision: 'approved' | 'rejected'
    approvalId: string
    correlationId: string
    createdAt: number
  }): Promise<AppResult<ChangeSetRecord>>
}
