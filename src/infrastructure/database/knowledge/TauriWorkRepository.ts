import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
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
} from '@/models/knowledge/work'
import { getTaskRunTransitionError } from '@/models/knowledge/work'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import type { WorkRepository } from '@/repositories/knowledge/WorkRepository'
import { loadAppSettings } from '@/models/settings/settings'
import { parseJsonObject, parseJsonOrNull } from '@/repositories/shared/jsonCodec'

export class TauriWorkRepository implements WorkRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async createDefinition(input: {
    id: string
    definitionType: TaskDefinitionType
    name: string
    instruction: string
    acceptanceCriteria?: AcceptanceCriteria
    executionPolicy?: Record<string, unknown>
    sourceKnowledgeObjectId?: string | null
    enabled?: boolean
    createdAt?: number
  }): Promise<AppResult<TaskDefinition>> {
    if (!input.name.trim() || !input.instruction.trim()) {
      return err({ code: 'validation-error', message: '任务定义名称和指令不能为空。' })
    }
    const now = input.createdAt ?? Date.now()
    try {
      await this.sqlClient.execute(
        `INSERT INTO task_definitions (
          id, definition_type, name, instruction, acceptance_criteria_json,
          execution_policy_json, source_knowledge_object_id, automation_id,
          enabled, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
        [
          input.id,
          input.definitionType,
          input.name.trim(),
          input.instruction.trim(),
          JSON.stringify(input.acceptanceCriteria ?? {}),
          JSON.stringify(input.executionPolicy ?? {}),
          input.sourceKnowledgeObjectId ?? null,
          input.enabled === false ? 0 : 1,
          now,
          now,
        ],
      )
      return ok({
        id: input.id,
        definitionType: input.definitionType,
        name: input.name.trim(),
        instruction: input.instruction.trim(),
        acceptanceCriteria: input.acceptanceCriteria ?? {},
        executionPolicy: input.executionPolicy ?? {},
        sourceKnowledgeObjectId: input.sourceKnowledgeObjectId ?? null,
        automationId: null,
        enabled: input.enabled !== false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      return err(normalizeError(error, '无法创建任务定义。'))
    }
  }

  async createRun(input: {
    id: string
    taskDefinitionId?: string | null
    frozenInput?: Record<string, unknown>
    acceptanceCriteria?: AcceptanceCriteria
    correlationId?: string
    causationId?: string | null
    queuedAt?: number
  }): Promise<AppResult<TaskRun>> {
    const queuedAt = input.queuedAt ?? Date.now()
    const run: TaskRun = {
      id: input.id,
      taskDefinitionId: input.taskDefinitionId ?? null,
      status: 'queued',
      frozenInput: input.frozenInput ?? {},
      acceptanceCriteria: input.acceptanceCriteria ?? {},
      output: null,
      error: null,
      contextBundleId: null,
      correlationId: input.correlationId ?? input.id,
      causationId: input.causationId ?? null,
      queuedAt,
      startedAt: null,
      completedAt: null,
    }
    try {
      await this.sqlClient.execute(
        `INSERT INTO task_runs (
          id, task_definition_id, status, frozen_input_json, acceptance_criteria_json,
          output_json, error, context_bundle_id, correlation_id, causation_id,
          queued_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
        [
          run.id,
          run.taskDefinitionId,
          run.status,
          JSON.stringify(run.frozenInput),
          JSON.stringify(run.acceptanceCriteria),
          run.correlationId,
          run.causationId,
          run.queuedAt,
        ],
      )
      return ok(run)
    } catch (error) {
      return err(normalizeError(error, '无法创建任务运行。'))
    }
  }

  async getRun(id: string): Promise<AppResult<TaskRun>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM task_runs WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapTaskRun(rows[0]))
        : err({ code: 'not-found', message: '任务运行不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取任务运行。'))
    }
  }

  async listRuns(limit = 100): Promise<AppResult<TaskRun[]>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM task_runs ORDER BY queued_at DESC LIMIT ?',
        [Math.max(1, Math.min(limit, 500))],
      )
      return ok(rows.map(mapTaskRun))
    } catch (error) {
      return err(normalizeError(error, '无法列出任务运行。'))
    }
  }

  async updateRunStatus(input: {
    id: string
    expectedStatus: TaskRunStatus
    status: TaskRunStatus
    output?: unknown
    error?: string | null
    startedAt?: number | null
    completedAt?: number | null
  }): Promise<AppResult<TaskRun>> {
    const transitionError = getTaskRunTransitionError(input.expectedStatus, input.status)
    if (transitionError) {
      return err({ code: 'validation-error', message: transitionError })
    }
    try {
      const result = await this.sqlClient.execute(
        `UPDATE task_runs SET status = ?, output_json = COALESCE(?, output_json), error = ?,
          started_at = COALESCE(?, started_at), completed_at = ? WHERE id = ? AND status = ?`,
        [
          input.status,
          input.output === undefined ? null : JSON.stringify(input.output),
          input.error ?? null,
          input.startedAt ?? null,
          input.completedAt ?? null,
          input.id,
          input.expectedStatus,
        ],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'revision-conflict', message: '任务运行状态已变化。' })
      }
      return this.getRun(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法更新任务运行。'))
    }
  }

  async addArtifact(artifact: WorkArtifact): Promise<AppResult<WorkArtifact>> {
    if (!artifact.uri && artifact.content === null) {
      return err({ code: 'validation-error', message: 'Artifact 必须提供 URI 或内容。' })
    }
    try {
      await this.sqlClient.execute(
        `INSERT INTO work_artifacts
         (id, task_run_id, artifact_type, name, uri, content_json, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          artifact.id,
          artifact.taskRunId,
          artifact.artifactType,
          artifact.name,
          artifact.uri,
          artifact.content === null ? null : JSON.stringify(artifact.content),
          artifact.contentHash,
          artifact.createdAt,
        ],
      )
      return ok(artifact)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Artifact。'))
    }
  }

  async listArtifacts(taskRunId: string): Promise<AppResult<WorkArtifact[]>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM work_artifacts WHERE task_run_id = ? ORDER BY created_at ASC',
        [taskRunId],
      )
      return ok(rows.map(mapArtifact))
    } catch (error) {
      return err(normalizeError(error, '无法读取 Artifact。'))
    }
  }

  async addEvidence(evidence: WorkEvidence): Promise<AppResult<WorkEvidence>> {
    if (!evidence.claim.trim()) {
      return err({ code: 'validation-error', message: 'Evidence claim 不能为空。' })
    }
    if (evidence.blockId && !evidence.documentId) {
      return err({ code: 'validation-error', message: 'Evidence blockId 必须带 documentId。' })
    }
    try {
      await this.sqlClient.execute(
        `INSERT INTO work_evidence (
          id, task_run_id, evidence_type, status, document_id, block_id, source_revision,
          artifact_id, claim, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidence.id,
          evidence.taskRunId,
          evidence.evidenceType,
          evidence.status,
          evidence.documentId,
          evidence.blockId,
          evidence.sourceRevision,
          evidence.artifactId,
          evidence.claim.trim(),
          JSON.stringify(evidence.details),
          evidence.createdAt,
        ],
      )
      return ok(evidence)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Evidence。'))
    }
  }

  async listEvidence(taskRunId: string): Promise<AppResult<WorkEvidence[]>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM work_evidence WHERE task_run_id = ? ORDER BY created_at ASC',
        [taskRunId],
      )
      return ok(rows.map(mapEvidence))
    } catch (error) {
      return err(normalizeError(error, '无法读取 Evidence。'))
    }
  }

  async finalizeVerification(input: {
    verification: ResultVerification
    proposedChangeSet: ChangeSetRecord | null
    expectedStatus: TaskRunStatus
    nextStatus: TaskRunStatus
  }): Promise<AppResult<ResultVerification>> {
    const transitionError = getTaskRunTransitionError(input.expectedStatus, input.nextStatus)
    if (transitionError) {
      return err({ code: 'validation-error', message: transitionError })
    }
    try {
      await invoke('commit_result_verification', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          id: input.verification.id,
          taskRunId: input.verification.taskRunId,
          verdict: input.verification.verdict,
          checksJson: JSON.stringify(input.verification.checks),
          summary: input.verification.summary,
          confirmationEnvelopeJson: JSON.stringify(input.verification.confirmationEnvelope),
          confirmationHash: input.verification.confirmationHash,
          proposedChangeSet: input.proposedChangeSet
            ? {
                id: input.proposedChangeSet.id,
                taskRunId: input.proposedChangeSet.taskRunId,
                title: input.proposedChangeSet.title,
                description: input.proposedChangeSet.description,
                createdAt: input.proposedChangeSet.createdAt,
              }
            : null,
          correlationId: input.verification.correlationId,
          eventId: `${input.verification.id}-event`,
          outboxId: `${input.verification.id}-outbox`,
          createdAt: input.verification.createdAt,
          expectedStatus: input.expectedStatus,
          nextStatus: input.nextStatus,
          completedAt: input.nextStatus === 'completed' ? input.verification.createdAt : null,
          error: input.verification.verdict === 'failed' ? input.verification.summary : null,
        },
      })
      return ok(input.verification)
    } catch (error) {
      return err(normalizeError(error, '无法原子提交验证结果。'))
    }
  }

  async createChangeSet(changeSet: ChangeSetRecord): Promise<AppResult<ChangeSetRecord>> {
    try {
      await this.sqlClient.execute(
        `INSERT INTO change_sets (
          id, task_run_id, agent_task_id, status, title, description,
          patch_set_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          changeSet.id,
          changeSet.taskRunId,
          changeSet.agentTaskId,
          changeSet.status,
          changeSet.title,
          changeSet.description,
          changeSet.patchSetTaskId,
          changeSet.createdAt,
          changeSet.updatedAt,
        ],
      )
      return ok(changeSet)
    } catch (error) {
      return err(normalizeError(error, '无法创建 ChangeSet。'))
    }
  }

  async decideChangeSet(input: {
    changeSetId: string
    decision: 'approved' | 'rejected'
    approvalId: string
    correlationId: string
    createdAt: number
  }): Promise<AppResult<ChangeSetRecord>> {
    try {
      await invoke('decide_change_set', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          changeSetId: input.changeSetId,
          decision: input.decision,
          approvalId: input.approvalId,
          correlationId: input.correlationId,
          eventId: `${input.approvalId}-event`,
          outboxId: `${input.approvalId}-outbox`,
          createdAt: input.createdAt,
        },
      })
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM change_sets WHERE id = ? LIMIT 1',
        [input.changeSetId],
      )
      return rows[0]
        ? ok(mapChangeSet(rows[0]))
        : err({ code: 'not-found', message: 'ChangeSet 不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法处理 ChangeSet。'))
    }
  }
}

function mapTaskRun(row: Record<string, unknown>): TaskRun {
  return {
    id: String(row.id),
    taskDefinitionId: nullableString(row.task_definition_id),
    status: String(row.status) as TaskRunStatus,
    frozenInput: parseJsonObject(row.frozen_input_json),
    acceptanceCriteria: parseJsonObject(row.acceptance_criteria_json) as AcceptanceCriteria,
    output: parseJsonOrNull(row.output_json),
    error: nullableString(row.error),
    contextBundleId: nullableString(row.context_bundle_id),
    correlationId: String(row.correlation_id),
    causationId: nullableString(row.causation_id),
    queuedAt: Number(row.queued_at),
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
  }
}

function mapArtifact(row: Record<string, unknown>): WorkArtifact {
  return {
    id: String(row.id),
    taskRunId: String(row.task_run_id),
    artifactType: String(row.artifact_type),
    name: String(row.name),
    uri: nullableString(row.uri),
    content: parseJsonOrNull(row.content_json),
    contentHash: nullableString(row.content_hash),
    createdAt: Number(row.created_at),
  }
}

function mapEvidence(row: Record<string, unknown>): WorkEvidence {
  return {
    id: String(row.id),
    taskRunId: String(row.task_run_id),
    evidenceType: String(row.evidence_type),
    status: String(row.status) as WorkEvidence['status'],
    documentId: nullableString(row.document_id),
    blockId: nullableString(row.block_id),
    sourceRevision: nullableNumber(row.source_revision),
    artifactId: nullableString(row.artifact_id),
    claim: String(row.claim),
    details: parseJsonObject(row.details_json),
    createdAt: Number(row.created_at),
  }
}

function mapChangeSet(row: Record<string, unknown>): ChangeSetRecord {
  return {
    id: String(row.id),
    taskRunId: nullableString(row.task_run_id),
    agentTaskId: nullableString(row.agent_task_id),
    status: String(row.status) as ChangeSetRecord['status'],
    title: String(row.title),
    description: String(row.description),
    patchSetTaskId: nullableString(row.patch_set_task_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}
import { invoke } from '@tauri-apps/api/core'
