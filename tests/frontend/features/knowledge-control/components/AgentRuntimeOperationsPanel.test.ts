import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import AgentRuntimeOperationsPanel from '@/features/knowledge-control/components/AgentRuntimeOperationsPanel.vue'
import type { AgentWorkerSnapshot } from '@/infrastructure/runtime/AgentWorkerSnapshotClient'
import type { AgentCommunicationRequest } from '@/repositories/agent/AgentCommunicationRepository'
import type { WorkflowTimerSnapshot } from '@/infrastructure/runtime/WorkflowTimerSnapshotClient'
import type { WorkflowScannerSnapshot } from '@/infrastructure/runtime/WorkflowScannerSnapshotClient'

const snapshot: AgentWorkerSnapshot = {
  status: 'running',
  supervisorInstanceId: 'supervisor-1',
  workerInstanceId: 'worker-1',
  pid: 321,
  activeRunIds: ['run-active'],
  activeRuns: [
    {
      runId: 'run-active',
      workItemId: 'task-1',
      sessionId: 'session-1',
      workflowId: null,
      objective: '检查路线图适配',
      intent: 'review',
    },
  ],
  pendingAuthorizations: [],
  pendingTerminals: [],
  lastHeartbeatAt: 10_000,
  restartCount: 1,
  lastError: null,
}

const timerSnapshot: WorkflowTimerSnapshot = {
  status: 'running',
  lastTickAt: 10_000,
  lastSuccessAt: 10_000,
  lastError: null,
  scheduledCount: 4,
  processingCount: 1,
  retryCount: 2,
  dueCount: 1,
  deadLetterCount: 1,
  maxLagMs: 250,
}

const workflowSnapshot: WorkflowScannerSnapshot = {
  status: 'running',
  lastTickAt: 10_000,
  lastSuccessAt: 10_000,
  lastError: null,
  resumedEventWaitCount: 2,
  resumedSatisfiedWaitCount: 3,
  automationEnqueuedCount: 4,
  signalEnqueuedCount: 5,
  actionRecoveredCount: 6,
}

function request(overrides: Partial<AgentCommunicationRequest>): AgentCommunicationRequest {
  return {
    id: 'request-1',
    runId: 'run-1',
    cognitiveSessionId: null,
    prompt: '整理项目状态',
    mode: 'agent',
    projectId: null,
    branchId: null,
    branchTitle: null,
    parentConversationId: null,
    status: 'queued',
    taskId: null,
    previousTaskId: null,
    revisionFeedback: null,
    revisionCount: 0,
    attemptCount: 2,
    nextAttemptAt: null,
    deadLetteredAt: null,
    lastFailureKind: null,
    error: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    result: null,
    decision: null,
    ...overrides,
  }
}

describe('AgentRuntimeOperationsPanel', () => {
  it('shows worker recovery, retry and dead-letter projections and refreshes from events', async () => {
    const getSnapshot = vi.fn(async () => snapshot)
    const getRequests = vi
      .fn<() => Promise<AgentCommunicationRequest[]>>()
      .mockResolvedValueOnce([
        request({ nextAttemptAt: 20_000, lastFailureKind: 'retryable' }),
        request({
          id: 'request-dead',
          status: 'failed',
          deadLetteredAt: 30_000,
          lastFailureKind: 'worker_crash',
          error: 'worker exited',
        }),
      ])
      .mockResolvedValue([])
    let workerListener: ((value: AgentWorkerSnapshot) => void) | null = null
    let queueListener: (() => void) | null = null
    let timerListener: ((value: WorkflowTimerSnapshot) => void) | null = null
    let workflowListener: ((value: WorkflowScannerSnapshot) => void) | null = null
    const wrapper = mount(AgentRuntimeOperationsPanel, {
      props: {
        getSnapshot,
        getRequests,
        getTimerSnapshot: async () => timerSnapshot,
        getWorkflowSnapshot: async () => workflowSnapshot,
        subscribeSnapshot: async (listener) => {
          workerListener = listener
          return vi.fn()
        },
        subscribeQueue: async (listener) => {
          queueListener = listener
          return vi.fn()
        },
        subscribeTimerSnapshot: async (listener) => {
          timerListener = listener
          return vi.fn()
        },
        subscribeWorkflowSnapshot: async (listener) => {
          workflowListener = listener
          return vi.fn()
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('运行正常')
    expect(wrapper.text()).toContain('重启 1 次')
    expect(wrapper.text()).toContain('检查路线图适配')
    expect(wrapper.text()).toContain('等待重试')
    expect(wrapper.text()).toContain('死信')
    expect(wrapper.text()).toContain('Worker 异常退出：worker exited')
    expect(wrapper.text()).toContain('Durable Timer')
    expect(wrapper.text()).toContain('250ms')
    expect(wrapper.text()).toContain('Workflow Scanner')
    expect(wrapper.text()).toContain('Action 恢复6')

    workerListener?.({ ...snapshot, status: 'restarting', activeRuns: [] })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('重启中')

    timerListener?.({ ...timerSnapshot, status: 'degraded', lastError: 'database busy' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('运行降级')
    expect(wrapper.text()).toContain('database busy')

    workflowListener?.({
      ...workflowSnapshot,
      status: 'degraded',
      lastError: 'workflow scanner failed',
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('workflow scanner failed')

    queueListener?.()
    await flushPromises()
    expect(getRequests).toHaveBeenCalledTimes(2)
  })
})
