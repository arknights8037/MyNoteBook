import { invoke } from '@tauri-apps/api/core'

import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'
import type { AgentToolCall } from '@/models/agentTool'
import { normalizeError, err, ok, type AppResult } from '@/models/result'
import { loadAppSettings } from '@/models/settings'
import type {
  AgentDocumentTransaction,
  ApplyAgentDocumentCreationInput,
  AgentRepository,
  AppliedAgentPatchSet,
  ApplyAgentPatchSetInput,
} from '@/repositories/AgentRepository'
import type { SqlClient } from '@/repositories/SqlClient'
import { TauriDocumentRepository } from './TauriDocumentRepository'

interface AgentTransactionCommandResult {
  id: string
  taskId: string
  documentId: string
  beforeRevision: number
  resultingRevision: number
  createdAt: number
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
          current_step, error, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ],
      )
      return ok(task)
    } catch (error) {
      return err(normalizeError(error, '无法创建 Agent 任务。'))
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
          started_at, completed_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ],
      )
      return ok(call)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Agent 工具调用记录。'))
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
    const expectedRevision = input.acceptedPatches[0]?.expectedVersion
    if (expectedRevision === undefined) {
      return err({ code: 'not-found', message: '目标补丁不存在。' })
    }
    const now = Date.now()
    try {
      const acceptedIds = new Set(input.acceptedPatches.map((patch) => patch.patchId))
      const result = await invoke<AgentTransactionCommandResult>('apply_agent_patch_set', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          taskId: input.task.id,
          documentId: input.task.sessionId,
          expectedRevision,
          contentJson: input.contentJson,
          plainText: input.plainText,
          transactionId: input.transactionId,
          patches: input.patchSet.patches.map((patch) => ({
            id: patch.patchId,
            afterText: patch.after,
            accepted: acceptedIds.has(patch.patchId),
          })),
          createdAt: now,
        },
      })
      const saved = await this.documentRepository.findById(input.task.sessionId)
      if (!saved.ok) return saved
      return ok({ document: saved.value, transaction: mapTransaction(result, 'applied', null) })
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
          plainText: input.plainText,
          transactionId: input.transactionId,
          createdAt: now,
        },
      })
      const created = await this.documentRepository.findById(input.patch.documentId)
      if (!created.ok) return created
      return ok({ document: created.value, transaction: mapTransaction(result, 'applied', null) })
    } catch (error) {
      return err(normalizeError(error, 'Agent 新建文档失败，数据库未发生变更。'))
    }
  }

  async rollbackTransaction(transactionId: string): Promise<AppResult<AppliedAgentPatchSet>> {
    const now = Date.now()
    try {
      const result = await invoke<AgentTransactionCommandResult>('rollback_agent_transaction', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          transactionId,
          rolledBackAt: now,
        },
      })
      if (result.beforeRevision === 0) {
        return ok({ document: null, transaction: mapTransaction(result, 'rolled_back', now) })
      }
      const saved = await this.documentRepository.findById(result.documentId)
      if (!saved.ok) return saved
      return ok({ document: saved.value, transaction: mapTransaction(result, 'rolled_back', now) })
    } catch (error) {
      return err(normalizeError(error, '无法撤销 Agent 修改。'))
    }
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
