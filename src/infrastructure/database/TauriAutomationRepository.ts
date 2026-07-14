import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationTask,
  AutomationTriggerType,
  CreateAutomationInput,
} from '@/models/automation'
import { normalizeAutomationTriggerConfig } from '@/models/automation'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import type { AutomationRepository } from '@/repositories/AutomationRepository'
import type { SqlClient } from '@/repositories/SqlClient'

interface AutomationTaskRow extends Record<string, unknown> {
  id: string
  name: string
  instruction: string
  trigger_type: string
  trigger_config_json: string
  document_id: string | null
  enabled: number
  next_run_at: number | null
  last_run_at: number | null
  created_at: number
  updated_at: number
}

interface AutomationRunRow extends Record<string, unknown> {
  id: string
  automation_id: string | null
  automation_name?: string | null
  trigger_source: string
  status: string
  input_json: string
  output_json: string | null
  error: string | null
  queued_at: number
  started_at: number | null
  completed_at: number | null
}

export class TauriAutomationRepository implements AutomationRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async listTasks(): Promise<AppResult<AutomationTask[]>> {
    try {
      const rows = await this.sqlClient.select<AutomationTaskRow>(
        `SELECT * FROM automation_tasks ORDER BY enabled DESC, updated_at DESC, id ASC`,
      )
      return ok(rows.map(mapTaskRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取自动化任务。'))
    }
  }

  async listDueTasks(now: number, limit = 20): Promise<AppResult<AutomationTask[]>> {
    try {
      const rows = await this.sqlClient.select<AutomationTaskRow>(
        `SELECT * FROM automation_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`,
        [now, Math.max(1, Math.min(limit, 100))],
      )
      return ok(rows.map(mapTaskRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取待运行的自动化任务。'))
    }
  }

  async createTask(input: CreateAutomationInput): Promise<AppResult<AutomationTask>> {
    const createdAt = input.createdAt ?? Date.now()
    const task: AutomationTask = {
      id: input.id,
      name: input.name.trim(),
      instruction: input.instruction.trim(),
      triggerType: input.triggerType,
      triggerConfig: normalizeAutomationTriggerConfig(input.triggerType, input.triggerConfig),
      documentId: input.documentId ?? null,
      enabled: input.enabled ?? true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt,
      updatedAt: createdAt,
    }
    if (!task.name || !task.instruction) {
      return err({ code: 'validation-error', message: '自动化名称和任务指令不能为空。' })
    }
    try {
      await this.sqlClient.execute(
        `INSERT INTO automation_tasks (
          id, name, instruction, trigger_type, trigger_config_json, document_id,
          enabled, next_run_at, last_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.name,
          task.instruction,
          task.triggerType,
          JSON.stringify(task.triggerConfig),
          task.documentId,
          task.enabled ? 1 : 0,
          task.nextRunAt,
          task.lastRunAt,
          task.createdAt,
          task.updatedAt,
        ],
      )
      return ok(task)
    } catch (error) {
      return err(normalizeError(error, '无法创建自动化任务。'))
    }
  }

  async setTaskEnabled(
    id: string,
    enabled: boolean,
    nextRunAt: number | null,
    updatedAt: number,
  ): Promise<AppResult<AutomationTask>> {
    try {
      const result = await this.sqlClient.execute(
        `UPDATE automation_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
        [enabled ? 1 : 0, nextRunAt, updatedAt, id],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'not-found', message: '自动化任务不存在。' })
      }
      return this.findTask(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新自动化任务。'))
    }
  }

  async deleteTask(id: string): Promise<AppResult<string>> {
    try {
      const result = await this.sqlClient.execute(`DELETE FROM automation_tasks WHERE id = ?`, [id])
      return result.rowsAffected === 1
        ? ok(id)
        : err({ code: 'not-found', message: '自动化任务不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除自动化任务。'))
    }
  }

  async enqueueRun(
    run: AutomationRun,
    scheduleNextRunAt: number | null,
  ): Promise<AppResult<AutomationRun>> {
    try {
      await this.sqlClient.execute(
        `INSERT INTO automation_runs (
          id, automation_id, trigger_source, status, input_json, output_json,
          error, schedule_next_run_at, queued_at, started_at, completed_at,
          correlation_id, causation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          run.automationId,
          run.triggerSource,
          run.status,
          run.inputJson,
          run.outputJson,
          run.error,
          scheduleNextRunAt,
          run.queuedAt,
          run.startedAt,
          run.completedAt,
          run.id,
          run.automationId,
        ],
      )
      return ok(run)
    } catch (error) {
      return err(normalizeError(error, '无法加入自动化运行队列。'))
    }
  }

  async listRuns(limit = 100): Promise<AppResult<AutomationRun[]>> {
    try {
      const rows = await this.sqlClient.select<AutomationRunRow>(
        `SELECT run.*, task.name AS automation_name
         FROM automation_runs run
         LEFT JOIN automation_tasks task ON task.id = run.automation_id
         ORDER BY run.queued_at DESC LIMIT ?`,
        [Math.max(1, Math.min(limit, 500))],
      )
      return ok(rows.map(mapRunRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取自动化运行记录。'))
    }
  }

  async updateRunStatus(input: {
    id: string
    status: AutomationRunStatus
    startedAt?: number | null
    completedAt?: number | null
    outputJson?: string | null
    error?: string | null
  }): Promise<AppResult<AutomationRun>> {
    try {
      const result = await this.sqlClient.execute(
        `UPDATE automation_runs
         SET status = ?, started_at = COALESCE(?, started_at), completed_at = ?,
             output_json = ?, error = ?
         WHERE id = ?`,
        [
          input.status,
          input.startedAt ?? null,
          input.completedAt ?? null,
          input.outputJson ?? null,
          input.error ?? null,
          input.id,
        ],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'not-found', message: '自动化运行记录不存在。' })
      }
      return this.findRun(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法更新自动化运行状态。'))
    }
  }

  private async findTask(id: string): Promise<AppResult<AutomationTask>> {
    const rows = await this.sqlClient.select<AutomationTaskRow>(
      `SELECT * FROM automation_tasks WHERE id = ? LIMIT 1`,
      [id],
    )
    return rows[0]
      ? ok(mapTaskRow(rows[0]))
      : err({ code: 'not-found', message: '自动化任务不存在。' })
  }

  private async findRun(id: string): Promise<AppResult<AutomationRun>> {
    const rows = await this.sqlClient.select<AutomationRunRow>(
      `SELECT run.*, task.name AS automation_name
       FROM automation_runs run
       LEFT JOIN automation_tasks task ON task.id = run.automation_id
       WHERE run.id = ? LIMIT 1`,
      [id],
    )
    return rows[0]
      ? ok(mapRunRow(rows[0]))
      : err({ code: 'not-found', message: '自动化运行记录不存在。' })
  }
}

function mapTaskRow(row: AutomationTaskRow): AutomationTask {
  const triggerType = ['manual', 'interval', 'daily'].includes(row.trigger_type)
    ? (row.trigger_type as AutomationTriggerType)
    : 'manual'
  return {
    id: row.id,
    name: row.name,
    instruction: row.instruction,
    triggerType,
    triggerConfig: normalizeAutomationTriggerConfig(
      triggerType,
      parseObject(row.trigger_config_json),
    ),
    documentId: row.document_id,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRunRow(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name ?? undefined,
    triggerSource: mapValue(row.trigger_source, ['manual', 'schedule', 'retry'], 'manual'),
    status: mapValue(
      row.status,
      ['queued', 'running', 'completed', 'failed', 'cancelled'],
      'failed',
    ),
    inputJson: row.input_json,
    outputJson: row.output_json,
    error: row.error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function mapValue<T extends string>(value: string, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}
