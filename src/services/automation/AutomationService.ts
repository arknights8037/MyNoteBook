import {
  calculateNextAutomationRun,
  type AutomationRun,
  type AutomationTask,
  type AutomationTriggerConfig,
  type AutomationTriggerSource,
  type AutomationTriggerType,
} from '@/models/automation/automation'
import type { AppResult } from '@/models/shared/result'
import type { AutomationRepository } from '@/repositories/automation/AutomationRepository'

export interface CreateAutomationCommand {
  name: string
  instruction: string
  triggerType: AutomationTriggerType
  triggerConfig?: AutomationTriggerConfig
  documentId?: string | null
  enabled?: boolean
}

export class AutomationService {
  constructor(
    private readonly repository: AutomationRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  listTasks(): Promise<AppResult<AutomationTask[]>> {
    return this.repository.listTasks()
  }

  listRuns(limit = 100): Promise<AppResult<AutomationRun[]>> {
    return this.repository.listRuns(limit)
  }

  async createTask(command: CreateAutomationCommand): Promise<AppResult<AutomationTask>> {
    const createdAt = this.now()
    const created = await this.repository.createTask({
      ...command,
      id: this.createId('automation'),
      createdAt,
    })
    if (!created.ok || !created.value.enabled) return created
    const nextRunAt = calculateNextAutomationRun(
      created.value.triggerType,
      created.value.triggerConfig,
      createdAt,
    )
    return this.repository.setTaskEnabled(created.value.id, true, nextRunAt, createdAt)
  }

  async setTaskEnabled(task: AutomationTask, enabled: boolean): Promise<AppResult<AutomationTask>> {
    const now = this.now()
    const nextRunAt = enabled
      ? calculateNextAutomationRun(task.triggerType, task.triggerConfig, now)
      : null
    return this.repository.setTaskEnabled(task.id, enabled, nextRunAt, now)
  }

  deleteTask(id: string): Promise<AppResult<string>> {
    return this.repository.deleteTask(id)
  }

  async enqueueTask(
    task: AutomationTask,
    triggerSource: AutomationTriggerSource = 'manual',
  ): Promise<AppResult<AutomationRun>> {
    const queuedAt = this.now()
    const run: AutomationRun = {
      id: this.createId('automation-run'),
      automationId: task.id,
      automationName: task.name,
      triggerSource,
      status: 'queued',
      inputJson: JSON.stringify({
        instruction: task.instruction,
        documentId: task.documentId,
      }),
      outputJson: null,
      error: null,
      queuedAt,
      startedAt: null,
      completedAt: null,
    }
    const nextRunAt = calculateNextAutomationRun(task.triggerType, task.triggerConfig, queuedAt)
    return this.repository.enqueueRun(run, nextRunAt)
  }

  startRun(id: string): Promise<AppResult<AutomationRun>> {
    return this.repository.updateRunStatus({ id, status: 'running', startedAt: this.now() })
  }

  completeRun(id: string, output: unknown): Promise<AppResult<AutomationRun>> {
    return this.repository.updateRunStatus({
      id,
      status: 'completed',
      completedAt: this.now(),
      outputJson: JSON.stringify(output ?? null),
      error: null,
    })
  }

  failRun(id: string, error: string): Promise<AppResult<AutomationRun>> {
    return this.repository.updateRunStatus({
      id,
      status: 'failed',
      completedAt: this.now(),
      error,
    })
  }
}
