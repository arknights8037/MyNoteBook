import { describe, expect, it, vi } from 'vitest'

import { WorkService } from './WorkService'
import type { TaskRun } from '@/models/work'
import type { WorkRepository } from '@/repositories/WorkRepository'

describe('WorkService state machine', () => {
  it('allows explicit waiting approval transitions and rejects terminal rewinds', async () => {
    const updateRunStatus = vi.fn(async (input) => ({
      ok: true as const,
      value: { ...run('running'), status: input.status },
    }))
    const service = new WorkService({ updateRunStatus } as unknown as WorkRepository)

    const waiting = await service.transition(run('running'), 'waiting_approval')
    const invalid = await service.transition(run('completed'), 'running')

    expect(waiting.ok).toBe(true)
    expect(updateRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: 'running', status: 'waiting_approval' }),
    )
    expect(invalid).toMatchObject({ ok: false, error: { code: 'validation-error' } })
  })
})

function run(status: TaskRun['status']): TaskRun {
  return {
    id: 'run-1',
    taskDefinitionId: null,
    status,
    frozenInput: {},
    acceptanceCriteria: {},
    output: null,
    error: null,
    contextBundleId: null,
    correlationId: 'run-1',
    causationId: null,
    queuedAt: 1,
    startedAt: status === 'queued' ? null : 2,
    completedAt: status === 'completed' ? 3 : null,
  }
}
