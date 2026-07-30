import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import type { AgentTask } from '@/models/agent/agent'
import type {
  AgentCommunicationRequest,
  AgentCommunicationService,
} from '@/services/agent/AgentCommunicationService'
import { useAgentCommunicationWorker } from '@/features/workspace/components/home/useAgentCommunicationWorker'

describe('useAgentCommunicationWorker', () => {
  it('does not claim or execute requests when Rust owns background orchestration', async () => {
    const claimNext = vi.fn(async () => null)
    const worker = useAgentCommunicationWorker({
      backgroundOwned: true,
      getService: async () => ({ claimNext }) as never,
      agentRun: {} as Parameters<typeof useAgentCommunicationWorker>[0]['agentRun'],
      conversation: {} as Parameters<typeof useAgentCommunicationWorker>[0]['conversation'],
      aiIsRunning: ref(false),
      isApplyingPatches: ref(false),
      pendingTask: ref(null),
      pendingPatchSet: ref(null),
      showPatchModal: ref(false),
      aiError: ref(''),
      createDocumentSnapshot: vi.fn() as never,
      acceptAllPatches: vi.fn(),
      rejectPatches: vi.fn(),
      notifyError: vi.fn(),
      createId: () => 'id',
    })

    await worker.poll()

    expect(claimNext).not.toHaveBeenCalled()
  })
  it('applies an approved request and marks it completed after the patch clears', async () => {
    const task = { id: 'task-1' } as AgentTask
    const pendingTask = ref<AgentTask | null>(task)
    const decision = {
      id: 'request-1',
      runId: 'run-1',
      cognitiveSessionId: null,
      prompt: '同步修改',
      mode: 'agent',
      projectId: null,
      branchId: null,
      branchTitle: null,
      parentConversationId: null,
      status: 'approved',
      taskId: 'task-1',
      previousTaskId: null,
      revisionFeedback: null,
      revisionCount: 0,
      attemptCount: 1,
      nextAttemptAt: null,
      deadLetteredAt: null,
      lastFailureKind: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
      result: null,
      decision: null,
    } satisfies AgentCommunicationRequest
    const markCompleted = vi.fn(async () => undefined)
    const service = {
      listRecentCompleted: vi.fn(async () => []),
      findDecisionForTask: vi.fn(async () => decision),
      markCompleted,
    } as unknown as AgentCommunicationService
    const acceptAllPatches = vi.fn(async () => {
      pendingTask.value = null
    })

    const worker = useAgentCommunicationWorker({
      getService: async () => service,
      agentRun: {} as Parameters<typeof useAgentCommunicationWorker>[0]['agentRun'],
      conversation: {
        migrateLeakedTask: vi.fn(),
      } as unknown as Parameters<typeof useAgentCommunicationWorker>[0]['conversation'],
      aiIsRunning: ref(false),
      isApplyingPatches: ref(false),
      pendingTask,
      pendingPatchSet: ref(null),
      showPatchModal: ref(false),
      aiError: ref(''),
      createDocumentSnapshot: vi.fn(),
      acceptAllPatches,
      rejectPatches: vi.fn(async () => undefined),
      notifyError: vi.fn(),
      createId: () => 'id-1',
    })

    await worker.poll()

    expect(acceptAllPatches).toHaveBeenCalledOnce()
    expect(markCompleted).toHaveBeenCalledWith('request-1', 'task-1')
  })

  it('uses the Rust queue watcher instead of a WebView interval', async () => {
    const claimNext = vi.fn(async () => null)
    const service = {
      listRecentCompleted: vi.fn(async () => []),
      claimNext,
    } as unknown as AgentCommunicationService
    let wake: (() => void) | null = null
    const unlisten = vi.fn()
    const watchQueue = vi.fn(async (listener: () => void) => {
      wake = listener
      return unlisten
    })
    const worker = useAgentCommunicationWorker({
      getService: async () => service,
      agentRun: {} as Parameters<typeof useAgentCommunicationWorker>[0]['agentRun'],
      conversation: {
        migrateLeakedTask: vi.fn(),
      } as unknown as Parameters<typeof useAgentCommunicationWorker>[0]['conversation'],
      aiIsRunning: ref(false),
      isApplyingPatches: ref(false),
      pendingTask: ref(null),
      pendingPatchSet: ref(null),
      showPatchModal: ref(false),
      aiError: ref(''),
      createDocumentSnapshot: vi.fn(),
      acceptAllPatches: vi.fn(async () => undefined),
      rejectPatches: vi.fn(async () => undefined),
      notifyError: vi.fn(),
      createId: () => 'id-1',
      watchQueue,
    })

    worker.start()
    await vi.waitFor(() => expect(watchQueue).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalledOnce())
    wake?.()
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalledTimes(2))
    worker.stop()
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
