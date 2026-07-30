import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import { TauriAgentCommunicationRepository } from '@/infrastructure/database/agent/TauriAgentCommunicationRepository'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const NOW = 4_000_000
const execute = vi.fn()
const select = vi.fn()
const client: SqlClient = { mutate: execute, select }

describe('TauriAgentCommunicationRepository', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
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

    expect(invoke).toHaveBeenCalledWith('settle_agent_request', {
      input: expect.objectContaining({
        id: 'request-1',
        status: 'awaiting_review',
        taskId: 'task-1',
        error: null,
        result,
        completedAt: null,
      }),
    })
  })

  it('preserves an existing result when approval later marks the request completed', async () => {
    await new TauriAgentCommunicationRepository(client, () => NOW).markCompleted(
      'request-1',
      'task-1',
    )

    expect(invoke).toHaveBeenCalledWith('settle_agent_request', {
      input: expect.objectContaining({
        id: 'request-1',
        status: 'completed',
        taskId: 'task-1',
        result: null,
        completedAt: NOW,
      }),
    })
  })

  it('only reclaims a running request after the maximum Runtime window', async () => {
    invoke.mockResolvedValue({
      id: 'request-stale',
      prompt: '检查依据',
      mode: 'review',
      status: 'running',
      taskId: null,
      projectId: 'project-1',
      branchId: 'branch-1',
      branchTitle: '接口审阅',
      parentConversationId: 'conversation-1',
    })

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
    expect(invoke).toHaveBeenCalledWith('claim_agent_request', {
      input: expect.objectContaining({ previousTaskId: null }),
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns null when another worker wins the conditional claim', async () => {
    invoke.mockResolvedValue(null)

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
    invoke.mockResolvedValue({
      id: 'request-revision',
      prompt: '同步知识',
      status: 'running',
      taskId: null,
      previousTaskId: 'task-previous',
      revisionFeedback: '修正表名，其他内容保持不变',
      revisionCount: 1,
      result: previousResult,
    })

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
    expect(invoke).toHaveBeenCalledWith('claim_agent_request', {
      input: expect.objectContaining({ previousTaskId: 'task-previous' }),
    })
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
