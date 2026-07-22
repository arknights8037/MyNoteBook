import { describe, expect, it, vi } from 'vitest'

import { AutomationService } from '@/services/automation/AutomationService'
import type { AutomationTask } from '@/models/automation/automation'
import { ok } from '@/models/shared/result'
import type { AutomationRepository } from '@/repositories/automation/AutomationRepository'

describe('AutomationService', () => {
  it('creates an enabled interval task with a next run time', async () => {
    const repository = createRepository()
    const service = new AutomationService(
      repository,
      (prefix) => `${prefix}-1`,
      () => 1_000,
    )

    const result = await service.createTask({
      name: '整理行动项',
      instruction: '提取当前页面行动项',
      triggerType: 'interval',
      triggerConfig: { intervalMinutes: 30 },
    })

    expect(result.ok).toBe(true)
    expect(repository.setTaskEnabled).toHaveBeenCalledWith('automation-1', true, 1_801_000, 1_000)
  })

  it('enqueues a run with a frozen instruction and advances the schedule', async () => {
    const repository = createRepository()
    const service = new AutomationService(
      repository,
      (prefix) => `${prefix}-1`,
      () => 2_000,
    )

    const result = await service.enqueueTask(task(), 'schedule')

    expect(result.ok).toBe(true)
    expect(repository.enqueueRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'automation-run-1',
        triggerSource: 'schedule',
        status: 'queued',
        inputJson: expect.stringContaining('提取行动项'),
      }),
      3_602_000,
    )
  })
})

function createRepository() {
  const currentTask = task()
  return {
    listTasks: vi.fn().mockResolvedValue(ok([currentTask])),
    listDueTasks: vi.fn().mockResolvedValue(ok([])),
    createTask: vi.fn().mockImplementation(async (input) =>
      ok({
        ...currentTask,
        ...input,
        triggerConfig: input.triggerConfig ?? {},
        enabled: input.enabled ?? true,
        createdAt: input.createdAt ?? 1_000,
        updatedAt: input.createdAt ?? 1_000,
      }),
    ),
    setTaskEnabled: vi
      .fn()
      .mockImplementation(async (_id, enabled, nextRunAt, updatedAt) =>
        ok({ ...currentTask, enabled, nextRunAt, updatedAt }),
      ),
    deleteTask: vi.fn().mockResolvedValue(ok('automation-1')),
    enqueueRun: vi.fn().mockImplementation(async (run) => ok(run)),
    listRuns: vi.fn().mockResolvedValue(ok([])),
    updateRunStatus: vi.fn(),
  } satisfies AutomationRepository
}

function task(): AutomationTask {
  return {
    id: 'automation-1',
    name: '整理行动项',
    instruction: '提取行动项',
    triggerType: 'interval',
    triggerConfig: { intervalMinutes: 60 },
    documentId: 'doc-1',
    enabled: true,
    nextRunAt: 0,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}
