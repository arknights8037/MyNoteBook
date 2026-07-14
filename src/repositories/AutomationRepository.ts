import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationTask,
  CreateAutomationInput,
} from '@/models/automation'
import type { AppResult } from '@/models/result'

export interface AutomationRepository {
  listTasks(): Promise<AppResult<AutomationTask[]>>
  listDueTasks(now: number, limit?: number): Promise<AppResult<AutomationTask[]>>
  createTask(input: CreateAutomationInput): Promise<AppResult<AutomationTask>>
  setTaskEnabled(
    id: string,
    enabled: boolean,
    nextRunAt: number | null,
    updatedAt: number,
  ): Promise<AppResult<AutomationTask>>
  deleteTask(id: string): Promise<AppResult<string>>
  enqueueRun(
    run: AutomationRun,
    scheduleNextRunAt: number | null,
  ): Promise<AppResult<AutomationRun>>
  listRuns(limit?: number): Promise<AppResult<AutomationRun[]>>
  updateRunStatus(input: {
    id: string
    status: AutomationRunStatus
    startedAt?: number | null
    completedAt?: number | null
    outputJson?: string | null
    error?: string | null
  }): Promise<AppResult<AutomationRun>>
}
