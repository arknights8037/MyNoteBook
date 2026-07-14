import type { AppResult } from '@/models/result'
import type { TaskRun, TaskRunStatus } from '@/models/work'
import type { WorkRepository } from '@/repositories/WorkRepository'

const TRANSITIONS: Record<TaskRunStatus, TaskRunStatus[]> = {
  queued: ['running', 'cancelled', 'stale'],
  running: ['waiting_input', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled', 'timed_out'],
  waiting_input: ['running', 'blocked', 'cancelled', 'stale'],
  waiting_approval: ['running', 'completed', 'blocked', 'cancelled', 'stale'],
  blocked: ['running', 'cancelled', 'stale'],
  completed: ['stale'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
  timed_out: ['queued', 'cancelled'],
  stale: ['queued', 'cancelled'],
}

export class WorkService {
  constructor(private readonly repository: WorkRepository) {}

  async transition(
    run: TaskRun,
    status: TaskRunStatus,
    options: { output?: unknown; error?: string | null } = {},
  ): Promise<AppResult<TaskRun>> {
    if (!TRANSITIONS[run.status].includes(status)) {
      return {
        ok: false,
        error: {
          code: 'validation-error',
          message: `不允许从 ${run.status} 转换为 ${status}。`,
        },
      }
    }
    const now = Date.now()
    return this.repository.updateRunStatus({
      id: run.id,
      expectedStatus: run.status,
      status,
      output: options.output,
      error: options.error,
      startedAt: status === 'running' && run.startedAt === null ? now : undefined,
      completedAt: ['completed', 'failed', 'cancelled', 'timed_out'].includes(status) ? now : null,
    })
  }
}
