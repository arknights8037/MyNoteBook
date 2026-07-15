import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, select, getDatabase } = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  getDatabase: vi.fn(),
}))

vi.mock('@/infrastructure/database/connection', () => ({ getDatabase }))

import { AgentCommunicationService } from './AgentCommunicationService'

describe('AgentCommunicationService', () => {
  beforeEach(() => {
    execute.mockReset()
    execute.mockResolvedValue({ rowsAffected: 1 })
    select.mockReset()
    select.mockResolvedValue([])
    getDatabase.mockReset()
    getDatabase.mockResolvedValue({ execute, select })
  })

  it('persists the versioned Agent result with an awaiting-review request', async () => {
    const result = {
      version: 1 as const,
      outcome: 'proposal' as const,
      summary: '已自主检索并生成同步提案。',
      patchCount: 2,
      targetDocumentIds: ['doc-1', 'doc-2'],
    }

    await new AgentCommunicationService().markAwaitingReview('request-1', 'task-1', result)

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('result_json = COALESCE'),
      expect.arrayContaining(['awaiting_review', 'task-1', JSON.stringify(result), 'request-1']),
    )
  })

  it('preserves an existing result when approval later marks the request completed', async () => {
    await new AgentCommunicationService().markCompleted('request-1', 'task-1')

    const parameters = execute.mock.calls[0]?.[1] as unknown[]
    expect(parameters[3]).toBeNull()
    expect(parameters.at(-1)).toBe('request-1')
  })

  it('reclaims a stale running request that never received a task id', async () => {
    select.mockResolvedValue([
      { id: 'request-stale', prompt: '继续同步', status: 'running', task_id: null },
    ])

    const request = await new AgentCommunicationService().claimNext()

    expect(request).toMatchObject({ id: 'request-stale', status: 'running', taskId: null })
    expect(select).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      expect.any(Number),
    ])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('task_id IS NULL'), [
      expect.any(Number),
      'request-stale',
      expect.any(Number),
    ])
  })

  it('claims a revision only for the pending proposal task and preserves continuation context', async () => {
    const previousResult = {
      version: 1,
      outcome: 'proposal',
      summary: '上一版提案',
      patchCount: 2,
      targetDocumentIds: ['doc-1'],
    }
    select.mockResolvedValue([
      {
        id: 'request-revision',
        prompt: '同步知识',
        status: 'queued',
        task_id: null,
        previous_task_id: 'task-previous',
        revision_feedback: '修正表名，其他内容保持不变',
        revision_count: 1,
        result_json: JSON.stringify(previousResult),
      },
    ])

    const request = await new AgentCommunicationService().claimRevisionForTask('task-previous')

    expect(request).toMatchObject({
      id: 'request-revision',
      previousTaskId: 'task-previous',
      revisionFeedback: '修正表名，其他内容保持不变',
      revisionCount: 1,
      result: previousResult,
    })
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('previous_task_id = ?'), [
      expect.any(Number),
      'request-revision',
      'task-previous',
      expect.any(Number),
    ])
  })

  it('finds a failed communication request so its pending local proposal can be cleared', async () => {
    select.mockResolvedValue([
      { id: 'request-failed', prompt: '同步', status: 'failed', task_id: 'task-1' },
    ])

    const request = await new AgentCommunicationService().findFailedForTask('task-1')

    expect(request).toMatchObject({ id: 'request-failed', status: 'failed', taskId: 'task-1' })
    expect(select).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ['task-1'])
  })
})
