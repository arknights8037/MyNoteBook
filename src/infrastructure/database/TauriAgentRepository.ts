import { invoke } from '@tauri-apps/api/core'

import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'
import type { AgentToolCall } from '@/models/agentTool'
import { normalizeError, err, ok, type AppResult } from '@/models/result'
import { loadAppSettings } from '@/models/settings'
import type {
  AgentDocumentTransaction,
  AgentRecoveryState,
  ApplyAgentDocumentCreationInput,
  ApplyAgentGroupCreationInput,
  AgentRepository,
  AppliedAgentPatchSet,
  ApplyAgentPatchSetInput,
} from '@/repositories/AgentRepository'
import type { SqlClient } from '@/repositories/SqlClient'
import type { ContextBundle } from '@/models/contextBundle'
import { createDefaultExecutionPolicy } from '@/models/executionPolicy'
import { TauriDocumentRepository } from './TauriDocumentRepository'

interface AgentTransactionCommandResult {
  id: string
  taskId: string
  documentId: string
  beforeRevision: number
  resultingRevision: number
  createdAt: number
  childDocumentId?: string | null
}

interface AgentPatchBatchCommandResult {
  id: string
  taskId: string
  transactions: AgentTransactionCommandResult[]
}

interface AgentTaskRow extends Record<string, unknown> {
  id: string
  session_id: string
  project_id?: string | null
  conversation_id?: string | null
  status: string
  user_instruction: string
  context_scope: string
  model: string
  current_step: string
  created_at: number
  completed_at: number | null
  error: string | null
  correlation_id?: string | null
  causation_id?: string | null
  execution_policy_json?: string
  context_bundle_id?: string | null
  provider?: string | null
  task_run_id?: string | null
}

interface AgentPatchRow extends Record<string, unknown> {
  id: string
  task_id: string
  operation: string
  document_id: string
  block_id: string
  target_block_ids_json: string
  expected_version: number
  before_text: string
  after_text: string
  reason: string
  status: string
  document_title: string | null
  parent_document_id: string | null
}

interface AgentPatchSetRow extends Record<string, unknown> {
  task_id: string
  model: string
  created_at: number
}

interface AgentSourceRow extends Record<string, unknown> {
  document_id: string
  document_title: string
  block_ids_json: string
}

interface AgentTransactionRow extends Record<string, unknown> {
  id: string
  task_id: string
  document_id: string
  before_revision: number
  resulting_revision: number
  status: string
  created_at: number
  rolled_back_at: number | null
}

/** Persists Agent audit records and delegates multi-statement writes to Rust transactions. */
export class TauriAgentRepository implements AgentRepository {
  private readonly documentRepository: TauriDocumentRepository

  constructor(private readonly sqlClient: SqlClient) {
    this.documentRepository = new TauriDocumentRepository(sqlClient)
  }

  async createTask(task: AgentTask): Promise<AppResult<AgentTask>> {
    try {
      await this.sqlClient.execute(
        `INSERT INTO agent_tasks (
          id, session_id, document_id, status, user_instruction, context_scope, model,
          current_step, error, created_at, completed_at, correlation_id, causation_id,
          execution_policy_json, context_bundle_id, provider, project_id, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.sessionId,
          task.sessionId,
          task.status,
          task.userInstruction,
          task.contextScope,
          task.model,
          task.currentStep,
          task.error,
          task.createdAt,
          task.completedAt,
          task.correlationId,
          task.causationId,
          JSON.stringify(task.executionPolicy),
          task.contextBundleId,
          task.provider,
          task.projectId,
          task.conversationId,
        ],
      )
      return ok(task)
    } catch (error) {
      return err(normalizeError(error, '无法创建 Agent 任务。'))
    }
  }

  async loadRecoveryState(
    documentId: string,
    options: { markInterrupted?: boolean } = {},
  ): Promise<AppResult<AgentRecoveryState>> {
    try {
      if (options.markInterrupted) {
        const interruptedAt = Date.now()
        await invoke<number>('cleanup_orphan_agent_tasks', {
          input: {
            dataDirectory: loadAppSettings().dataDirectory,
            cleanedAt: interruptedAt,
          },
        })
        await this.sqlClient.execute(
          `UPDATE agent_tasks
           SET status = 'failed', current_step = '任务因应用中断而停止',
               error = '应用在任务完成前关闭。', completed_at = ?
           WHERE status IN ('pending', 'running')`,
          [interruptedAt],
        )
      }
      const taskRows = await this.sqlClient.select<AgentTaskRow>(
        `SELECT id, session_id, project_id, conversation_id, status, user_instruction, context_scope, model,
                current_step, error, created_at, completed_at, correlation_id, causation_id,
                execution_policy_json, context_bundle_id, provider, task_run_id
         FROM agent_tasks
         WHERE document_id = ? OR EXISTS (
           SELECT 1 FROM agent_patches patch
           WHERE patch.task_id = agent_tasks.id AND patch.document_id = ?
         )
         ORDER BY created_at DESC
         LIMIT 50`,
        [documentId, documentId],
      )
      const tasks = taskRows.map(mapTaskRow)
      const pendingTask = tasks.find((task) => task.status === 'waiting_confirmation') ?? null
      const pendingPatchSet = pendingTask ? await this.loadPatchSet(pendingTask.id) : null

      const transactionRows = await this.sqlClient.select<AgentTransactionRow>(
        `SELECT transaction_id AS id, task_id, target_document_id AS document_id,
                before_revision, resulting_revision, status, created_at, rolled_back_at
         FROM (
           SELECT COALESCE((
                    SELECT json_extract(confirmation.details_json, '$.batchId')
                    FROM agent_confirmations confirmation
                    WHERE confirmation.task_id = tx.task_id AND confirmation.action = 'applied'
                      AND confirmation.created_at = tx.created_at
                    ORDER BY confirmation.id DESC LIMIT 1
                  ), tx.id) AS transaction_id,
                  tx.task_id, tx.document_id AS target_document_id,
                  tx.before_revision, tx.resulting_revision, tx.status, tx.created_at,
                  tx.rolled_back_at
           FROM agent_document_transactions tx
           INNER JOIN agent_tasks task ON task.id = tx.task_id
           INNER JOIN documents document ON document.id = tx.document_id
           WHERE tx.document_id = ? AND tx.status = 'applied'
             AND document.is_deleted = 0 AND document.revision = tx.resulting_revision
           UNION ALL
           SELECT creation.id AS transaction_id, creation.task_id,
                  creation.document_id AS target_document_id, 0 AS before_revision,
                  1 AS resulting_revision, creation.status, creation.created_at,
                  creation.rolled_back_at
           FROM agent_document_creation_transactions creation
           INNER JOIN agent_tasks task ON task.id = creation.task_id
           INNER JOIN documents document ON document.id = creation.document_id
           WHERE task.document_id = ? AND creation.status = 'applied'
             AND document.is_deleted = 0 AND document.revision = 1
         )
         ORDER BY created_at DESC, id ASC
         LIMIT 1`,
        [documentId, documentId],
      )
      const lastAppliedTransaction = transactionRows[0]
        ? mapTransactionRow(transactionRows[0])
        : null
      let lastAppliedTask = lastAppliedTransaction
        ? (tasks.find((task) => task.id === lastAppliedTransaction.taskId) ?? null)
        : null
      if (lastAppliedTransaction && !lastAppliedTask) {
        const transactionTaskRows = await this.sqlClient.select<AgentTaskRow>(
          `SELECT id, session_id, project_id, conversation_id, status, user_instruction, context_scope, model,
                  current_step, error, created_at, completed_at, correlation_id, causation_id,
                  execution_policy_json, context_bundle_id, provider, task_run_id
           FROM agent_tasks
           WHERE id = ?
           LIMIT 1`,
          [lastAppliedTransaction.taskId],
        )
        lastAppliedTask = transactionTaskRows[0] ? mapTaskRow(transactionTaskRows[0]) : null
      }
      const lastAppliedPatchSet = lastAppliedTask
        ? await this.loadPatchSet(lastAppliedTask.id)
        : null

      return ok({
        tasks,
        pendingTask: pendingPatchSet ? pendingTask : null,
        pendingPatchSet,
        lastAppliedTask: lastAppliedPatchSet ? lastAppliedTask : null,
        lastAppliedPatchSet,
        lastAppliedTransaction: lastAppliedPatchSet ? lastAppliedTransaction : null,
      })
    } catch (error) {
      return err(normalizeError(error, '无法恢复 Agent 任务状态。'))
    }
  }

  async updateTask(task: AgentTask): Promise<AppResult<AgentTask>> {
    try {
      const result = await this.sqlClient.execute(
        `UPDATE agent_tasks
         SET status = ?, current_step = ?, error = ?, completed_at = ?
         WHERE id = ?`,
        [task.status, task.currentStep, task.error, task.completedAt, task.id],
      )
      return result.rowsAffected === 1
        ? ok(task)
        : err({ code: 'not-found', message: 'Agent 任务不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法更新 Agent 任务状态。'))
    }
  }

  async recordToolCall(call: AgentToolCall): Promise<AppResult<AgentToolCall>> {
    try {
      await this.sqlClient.execute(
        `INSERT INTO agent_tool_calls (
          id, task_id, tool_name, arguments_json, result_json, status,
          started_at, completed_at, error, correlation_id, causation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          result_json = excluded.result_json,
          status = excluded.status,
          completed_at = excluded.completed_at,
          error = excluded.error`,
        [
          call.id,
          call.taskId,
          call.toolName,
          call.argumentsJson,
          call.resultJson,
          call.status,
          call.startedAt,
          call.completedAt,
          call.error,
          call.taskId,
          call.taskId,
        ],
      )
      return ok(call)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Agent 工具调用记录。'))
    }
  }

  async saveContextBundle(
    bundle: ContextBundle,
    provenance: {
      provider: string
      modelParameters: Record<string, unknown>
      ignoredParameters: string[]
      skillVersions: Array<{ id: string; version: string | null }>
    },
  ): Promise<AppResult<ContextBundle>> {
    try {
      await invoke('save_agent_context_bundle', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          id: bundle.id,
          taskId: bundle.taskId,
          version: bundle.version,
          scopeJson: JSON.stringify(bundle.scope),
          permissionSnapshotJson: JSON.stringify(bundle.permissionSnapshot),
          sourcesJson: JSON.stringify(bundle.sources),
          activeRulesJson: JSON.stringify(bundle.activeRules),
          decisionsJson: JSON.stringify(bundle.decisions),
          conflictsJson: JSON.stringify(bundle.conflicts),
          compilerJson: JSON.stringify(bundle.compiler),
          snapshotHash: bundle.snapshotHash,
          correlationId: bundle.correlationId,
          causationId: bundle.causationId,
          executionPolicyJson: JSON.stringify(bundle.compiler.executionPolicy),
          provider: provenance.provider,
          modelParametersJson: JSON.stringify(provenance.modelParameters),
          ignoredParametersJson: JSON.stringify(provenance.ignoredParameters),
          skillVersionsJson: JSON.stringify(provenance.skillVersions),
          createdAt: bundle.createdAt,
        },
      })
      return ok(bundle)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Context Bundle。'))
    }
  }

  async savePatchSet(patchSet: AgentPatchSet): Promise<AppResult<AgentPatchSet>> {
    try {
      await invoke('save_agent_patch_set', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          taskId: patchSet.taskId,
          model: patchSet.model,
          createdAt: patchSet.createdAt,
          patches: patchSet.patches.map((patch) => ({
            id: patch.patchId,
            operation: patch.operation,
            documentId: patch.documentId,
            blockId: patch.blockId,
            targetBlockIdsJson: JSON.stringify(patch.targetBlockIds),
            expectedVersion: patch.expectedVersion,
            beforeText: patch.before,
            afterText: patch.after,
            reason: patch.reason,
            documentTitle: patch.documentTitle ?? null,
            parentDocumentId: patch.parentDocumentId ?? null,
          })),
          sources: patchSet.contextSources.map((source) => ({
            documentId: source.documentId,
            documentTitle: source.documentTitle,
            blockIdsJson: JSON.stringify(source.blockIds),
          })),
        },
      })
      return ok(patchSet)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Agent 补丁草案。'))
    }
  }

  async rejectPatchSet(task: AgentTask, patches: BlockPatch[]): Promise<AppResult<AgentTask>> {
    try {
      await invoke('reject_agent_patch_set', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          taskId: task.id,
          patchIds: patches.map((patch) => patch.patchId),
          completedAt: task.completedAt ?? Date.now(),
        },
      })
      return ok(task)
    } catch (error) {
      return err(normalizeError(error, '无法记录用户对 Agent 修改的拒绝操作。'))
    }
  }

  async applyPatchSet(input: ApplyAgentPatchSetInput): Promise<AppResult<AppliedAgentPatchSet>> {
    if (input.documents.length === 0) {
      return err({ code: 'not-found', message: '目标补丁不存在。' })
    }
    const now = Date.now()
    try {
      const acceptedIds = new Set(input.acceptedPatches.map((patch) => patch.patchId))
      const result = await invoke<AgentPatchBatchCommandResult>('apply_agent_patch_set', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          taskId: input.task.id,
          batchId: input.batchId,
          documents: input.documents.map((document) => ({
            documentId: document.documentId,
            expectedRevision: document.expectedRevision,
            contentJson: document.contentJson,
            transactionId: document.transactionId,
          })),
          patches: input.patchSet.patches.map((patch) => ({
            id: patch.patchId,
            afterText: patch.after,
            accepted: acceptedIds.has(patch.patchId),
          })),
          createdAt: now,
        },
      })
      const transactions = result.transactions.map((transaction) =>
        mapTransaction(transaction, 'applied', null),
      )
      const documents: NonNullable<AppliedAgentPatchSet['documents']> = []
      for (const mutation of input.documents) {
        const saved = await this.documentRepository.findById(mutation.documentId)
        if (!saved.ok) return saved
        if (saved.value) documents.push(saved.value)
      }
      const firstTransaction = transactions[0]
      if (!firstTransaction) {
        return err({ code: 'not-found', message: 'Agent 写入事务未生成。' })
      }
      return ok({
        document: documents[0] ?? null,
        documents,
        transaction: { ...firstTransaction, id: result.id },
        transactions,
      })
    } catch (error) {
      return err(normalizeError(error, 'Agent 修改写入失败，数据库未发生变更。'))
    }
  }

  async applyDocumentCreation(
    input: ApplyAgentDocumentCreationInput,
  ): Promise<AppResult<AppliedAgentPatchSet>> {
    if (input.patch.operation !== 'create_document' || !input.patch.documentTitle?.trim()) {
      return err({ code: 'validation-error', message: '新文档提案无效。' })
    }
    const now = Date.now()
    try {
      const result = await invoke<AgentTransactionCommandResult>('apply_agent_document_creation', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          taskId: input.task.id,
          patchId: input.patch.patchId,
          documentId: input.patch.documentId,
          parentDocumentId:
            input.patch.parentDocumentId === undefined
              ? input.task.sessionId
              : input.patch.parentDocumentId,
          title: input.patch.documentTitle,
          contentJson: input.contentJson,
          acceptedAfterText: input.patch.after,
          plainText: input.plainText,
          transactionId: input.transactionId,
          createdAt: now,
        },
      })
      const created = await this.documentRepository.findById(input.patch.documentId)
      if (!created.ok) return created
      return ok({
        document: created.value,
        createdDocuments: [created.value],
        transaction: mapTransaction(result, 'applied', null),
      })
    } catch (error) {
      return err(normalizeError(error, 'Agent 新建文档失败，数据库未发生变更。'))
    }
  }

  async applyGroupCreation(
    input: ApplyAgentGroupCreationInput,
  ): Promise<AppResult<AppliedAgentPatchSet>> {
    if (input.patch.operation !== 'create_group' || !input.patch.documentTitle?.trim()) {
      return err({ code: 'validation-error', message: '新分组提案无效。' })
    }
    const now = Date.now()
    try {
      const result = await invoke<AgentTransactionCommandResult>('apply_agent_group_creation', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          taskId: input.task.id,
          patchId: input.patch.patchId,
          groupDocumentId: input.patch.documentId,
          groupTitle: input.patch.documentTitle,
          childDocumentId: input.patch.blockId || null,
          childTitle: input.patch.before || null,
          childContentJson: input.childContentJson ?? null,
          childAfterText: input.patch.blockId ? input.patch.after : null,
          transactionId: input.transactionId,
          createdAt: now,
        },
      })
      const group = await this.documentRepository.findById(input.patch.documentId)
      if (!group.ok) return group
      const createdDocuments = [group.value]
      if (input.patch.blockId) {
        const child = await this.documentRepository.findById(input.patch.blockId)
        if (!child.ok) return child
        createdDocuments.push(child.value)
      }
      return ok({
        document: group.value,
        createdDocuments,
        transaction: mapTransaction(result, 'applied', null),
      })
    } catch (error) {
      return err(normalizeError(error, 'Agent 新建分组失败，数据库未发生变更。'))
    }
  }

  async rollbackTransaction(transactionId: string): Promise<AppResult<AppliedAgentPatchSet>> {
    const now = Date.now()
    try {
      const batchRows = await this.sqlClient.select<{ document_id: string }>(
        `SELECT document_id FROM agent_document_transactions
         WHERE id = ? OR id LIKE ? ORDER BY id ASC`,
        [transactionId, `${transactionId}:%`],
      )
      const result = await invoke<AgentTransactionCommandResult>('rollback_agent_transaction', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          transactionId,
          rolledBackAt: now,
        },
      })
      if (result.beforeRevision === 0) {
        return ok({
          document: null,
          removedDocumentIds: [result.childDocumentId, result.documentId].filter(
            (value): value is string => Boolean(value),
          ),
          transaction: mapTransaction(result, 'rolled_back', now),
        })
      }
      const documents: NonNullable<AppliedAgentPatchSet['documents']> = []
      for (const row of batchRows) {
        const saved = await this.documentRepository.findById(row.document_id)
        if (!saved.ok) return saved
        if (saved.value) documents.push(saved.value)
      }
      if (documents.length === 0) {
        const saved = await this.documentRepository.findById(result.documentId)
        if (!saved.ok) return saved
        if (saved.value) documents.push(saved.value)
      }
      return ok({
        document: documents[0] ?? null,
        documents,
        transaction: { ...mapTransaction(result, 'rolled_back', now), id: transactionId },
      })
    } catch (error) {
      return err(normalizeError(error, '无法撤销 Agent 修改。'))
    }
  }

  private async loadPatchSet(taskId: string): Promise<AgentPatchSet | null> {
    const setRows = await this.sqlClient.select<AgentPatchSetRow>(
      `SELECT task_id, model, created_at
       FROM agent_patch_sets
       WHERE task_id = ?
       LIMIT 1`,
      [taskId],
    )
    const set = setRows[0]
    if (!set) return null

    const [patchRows, sourceRows] = await Promise.all([
      this.sqlClient.select<AgentPatchRow>(
        `SELECT id, task_id, operation, document_id, block_id, target_block_ids_json,
                expected_version, before_text, after_text, reason, status,
                document_title, parent_document_id
         FROM agent_patches
         WHERE task_id = ?
         ORDER BY created_at ASC, id ASC`,
        [taskId],
      ),
      this.sqlClient.select<AgentSourceRow>(
        `SELECT document_id, document_title, block_ids_json
         FROM agent_task_sources
         WHERE task_id = ?
         ORDER BY created_at ASC, document_id ASC`,
        [taskId],
      ),
    ])
    if (patchRows.length === 0) return null

    return {
      taskId: set.task_id,
      model: set.model,
      createdAt: set.created_at,
      patches: patchRows.map((row) => ({
        patchId: row.id,
        taskId: row.task_id,
        operation: mapPatchOperation(row.operation),
        documentId: row.document_id,
        blockId: row.block_id,
        targetBlockIds: parseStringArray(row.target_block_ids_json),
        expectedVersion: row.expected_version,
        before: row.before_text,
        after: row.after_text,
        reason: row.reason,
        accepted: row.status !== 'rejected',
        documentTitle: row.document_title ?? undefined,
        parentDocumentId: row.parent_document_id,
      })),
      contextSources: sourceRows.map((row) => ({
        documentId: row.document_id,
        documentTitle: row.document_title,
        blockIds: parseStringArray(row.block_ids_json),
      })),
    }
  }
}

function mapTaskRow(row: AgentTaskRow): AgentTask {
  const status = [
    'pending',
    'running',
    'waiting_confirmation',
    'completed',
    'failed',
    'cancelled',
  ].includes(row.status)
    ? (row.status as AgentTask['status'])
    : 'failed'
  const contextScope = ['selection', 'current_block', 'current_document'].includes(
    row.context_scope,
  )
    ? (row.context_scope as AgentTask['contextScope'])
    : 'current_document'
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id ?? '',
    conversationId: row.conversation_id ?? '',
    status,
    userInstruction: row.user_instruction,
    contextScope,
    model: row.model,
    currentStep: row.current_step,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    error: row.error,
    correlationId: row.correlation_id ?? row.id,
    causationId: row.causation_id ?? null,
    executionPolicy: parseExecutionPolicy(row.execution_policy_json),
    contextBundleId: row.context_bundle_id ?? null,
    provider: mapProvider(row.provider),
    taskRunId: row.task_run_id ?? null,
  }
}

function parseExecutionPolicy(value: string | undefined) {
  const fallback = createDefaultExecutionPolicy({ tokenBudget: 2048, allowedTools: [] })
  if (!value) return fallback
  try {
    return { ...fallback, ...(JSON.parse(value) as object), version: 1 as const }
  } catch {
    return fallback
  }
}

function mapProvider(value: unknown): AgentTask['provider'] {
  return ['openai', 'anthropic', 'deepseek', 'qwen', 'openai-compatible'].includes(String(value))
    ? (value as AgentTask['provider'])
    : 'openai'
}

function mapPatchOperation(value: string): BlockPatch['operation'] {
  return [
    'replace',
    'insert_before',
    'insert_after',
    'append',
    'create_document',
    'create_group',
  ].includes(value)
    ? (value as BlockPatch['operation'])
    : 'replace'
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function mapTransactionRow(row: AgentTransactionRow): AgentDocumentTransaction {
  return {
    id: row.id,
    taskId: row.task_id,
    documentId: row.document_id,
    beforeRevision: row.before_revision,
    resultingRevision: row.resulting_revision,
    status: row.status === 'rolled_back' ? 'rolled_back' : 'applied',
    createdAt: row.created_at,
    rolledBackAt: row.rolled_back_at,
  }
}

function mapTransaction(
  result: AgentTransactionCommandResult,
  status: AgentDocumentTransaction['status'],
  rolledBackAt: number | null,
): AgentDocumentTransaction {
  return {
    ...result,
    status,
    rolledBackAt,
  }
}
