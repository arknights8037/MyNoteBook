import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import type { AgentTask } from '@/models/agent/agent'
import type { AgentCommunicationRequest, AgentCommunicationService } from '@/services/agent/AgentCommunicationService'
import { useAgentCommunicationWorker } from '@/features/workspace/components/home/useAgentCommunicationWorker'

describe('useAgentCommunicationWorker', () => {
  it('applies an approved request and marks it completed after the patch clears', async () => {
    const task = { id: 'task-1' } as AgentTask
    const pendingTask = ref<AgentTask | null>(task)
    const decision = {
      id: 'request-1',
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
    })

    await worker.poll()

    expect(acceptAllPatches).toHaveBeenCalledOnce()
    expect(markCompleted).toHaveBeenCalledWith('request-1', 'task-1')
  })
})
