import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import { TauriAgentCommunicationRepository } from '@/infrastructure/database/agent/TauriAgentCommunicationRepository'

const NOW = 4_000_000
const execute = vi.fn()
const select = vi.fn()
const client: SqlClient = { execute, select }

describe('TauriAgentCommunicationRepository', () => {
  beforeEach(() => {
    execute.mockReset()
    execute.mockResolvedValue({ rowsAffected: 1 })
    select.mockReset()
    select.mockResolvedValue([])
  })

  it('persists the versioned Agent result with an awaiting-review request', async () => {
    const result = {
      version: 1 as const,
      outcome: 'proposal' as const,
      summary: '已自主检索并生成同步提案。',
      patchCount: 2,
      targetDocumentIds: ['doc-1', 'doc-2'],
    }

    await new TauriAgentCommunicationRepository(client, () => NOW).markAwaitingReview(
      'request-1',
      'task-1',
      result,
    )

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('result_json = COALESCE'),
      ['awaiting_review', 'task-1', null, JSON.stringify(result), NOW, null, 'request-1'],
    )
  })

  it('preserves an existing result when approval later marks the request completed', async () => {
    await new TauriAgentCommunicationRepository(client, () => NOW).markCompleted(
      'request-1',
      'task-1',
    )

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('result_json = COALESCE'), [
      'completed',
      'task-1',
      null,
      null,
      NOW,
      NOW,
      'request-1',
    ])
  })

  it('only reclaims a running request after the maximum Runtime window', async () => {
    select.mockResolvedValue([
      {
        id: 'request-stale',
        prompt: '检查依据',
        mode: 'review',
        status: 'running',
        task_id: null,
        project_id: 'project-1',
        branch_id: 'branch-1',
        branch_title: '接口审阅',
        parent_conversation_id: 'conversation-1',
      },
    ])

    const request = await new TauriAgentCommunicationRepository(client, () => NOW).claimNext()

    expect(request).toMatchObject({
      id: 'request-stale',
      mode: 'review',
      status: 'running',
      taskId: null,
      projectId: 'project-1',
      branchId: 'branch-1',
      branchTitle: '接口审阅',
      parentConversationId: 'conversation-1',
    })
    expect(select).toHaveBeenCalledWith(expect.stringContaining('updated_at < ?'), [
      NOW - 50 * 60 * 1_000,
    ])
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('task_id IS NULL'), [
      NOW,
      'request-stale',
      NOW - 50 * 60 * 1_000,
    ])
  })

  it('returns null when another worker wins the conditional claim', async () => {
    select.mockResolvedValue([
      { id: 'request-1', prompt: '同步知识', status: 'queued', task_id: null },
    ])
    execute.mockResolvedValue({ rowsAffected: 0 })

    await expect(
      new TauriAgentCommunicationRepository(client, () => NOW).claimNext(),
    ).resolves.toBeNull()
  })

  it('finds an approval decision only for the matching pending task', async () => {
    const decision = {
      version: 1,
      action: 'approve',
      reply: '已审阅 summary，批准同步。',
      requestId: 'request-approved',
      taskId: 'task-1',
      resultVersion: 1,
      resultSummary: '更新两篇维护资料。',
      decidedAt: 2_000,
    }
    select.mockResolvedValue([
      {
        id: 'request-approved',
        prompt: '同步知识',
        status: 'approved',
        task_id: 'task-1',
        decision_json: JSON.stringify(decision),
      },
    ])

    const request = await new TauriAgentCommunicationRepository(client).findDecisionForTask(
      'task-1',
    )

    expect(request?.decision).toEqual(decision)
    expect(select).toHaveBeenCalledWith(expect.stringContaining('task_id = ?'), ['task-1'])
  })

  it('claims a revision and preserves its continuation context', async () => {
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

    const request = await new TauriAgentCommunicationRepository(
      client,
      () => NOW,
    ).claimRevisionForTask('task-previous')

    expect(request).toMatchObject({
      id: 'request-revision',
      previousTaskId: 'task-previous',
      revisionFeedback: '修正表名，其他内容保持不变',
      revisionCount: 1,
      result: previousResult,
    })
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('previous_task_id = ?'), [
      NOW,
      'request-revision',
      'task-previous',
      NOW - 50 * 60 * 1_000,
    ])
  })

  it('finds a failed request and clamps completed history limits', async () => {
    select.mockResolvedValueOnce([
      { id: 'request-failed', prompt: '同步', status: 'failed', task_id: 'task-1' },
    ])
    const repository = new TauriAgentCommunicationRepository(client)

    await expect(repository.findFailedForTask('task-1')).resolves.toMatchObject({
      id: 'request-failed',
      status: 'failed',
      taskId: 'task-1',
    })
    await repository.listRecentCompleted(200)

    expect(select).toHaveBeenLastCalledWith(expect.stringContaining("status = 'completed'"), [100])
  })
})
