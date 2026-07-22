import { ref, type Ref } from 'vue'

import type { AgentPatchSet, AgentTask } from '@/models/agent/agent'
import type { AiChatMode } from '@/models/ai/aiChatMode'
import type {
  AgentCommunicationRequest,
  AgentCommunicationService,
} from '@/services/agent/AgentCommunicationService'
import type { AiConversationMessage, useAiConversation } from '@/composables/useAiConversation'
import type {
  AgentRunContinuation,
  AgentRunDocumentSnapshot,
  useAgentRun,
} from '@/composables/useAgentRun'

interface AgentCommunicationWorkerOptions {
  getService: () => Promise<AgentCommunicationService>
  agentRun: ReturnType<typeof useAgentRun>
  conversation: ReturnType<typeof useAiConversation>
  aiIsRunning: Readonly<Ref<boolean>>
  isApplyingPatches: Readonly<Ref<boolean>>
  pendingTask: Ref<AgentTask | null>
  pendingPatchSet: Ref<AgentPatchSet | null>
  showPatchModal: Ref<boolean>
  aiError: Readonly<Ref<string>>
  createDocumentSnapshot: () => Promise<AgentRunDocumentSnapshot>
  acceptAllPatches: () => Promise<void>
  rejectPatches: () => Promise<void>
  notifyError: (message: string) => void
}

export function useAgentCommunicationWorker(options: AgentCommunicationWorkerOptions) {
  let servicePromise: Promise<AgentCommunicationService> | null = null
  let timer: ReturnType<typeof globalThis.setInterval> | null = null
  let polling = false
  let checkedLegacyLeaks = false
  const service = () => (servicePromise ??= options.getService())

  async function poll(): Promise<void> {
    if (polling || options.aiIsRunning.value || options.isApplyingPatches.value) return
    polling = true
    let claimedRequest: AgentCommunicationRequest | null = null
    let continuation: AgentRunContinuation | undefined
    try {
      if (!checkedLegacyLeaks) {
        const completedRequests = await (await service()).listRecentCompleted()
        for (const completedRequest of completedRequests) {
          options.conversation.migrateLeakedTask({
            id: completedRequest.id,
            title: `A2A · ${completedRequest.prompt}`,
            prompt: toPrompt(completedRequest),
          })
        }
        checkedLegacyLeaks = true
      }

      const decision = options.pendingTask.value
        ? await (await service()).findDecisionForTask(options.pendingTask.value.id)
        : null
      if (decision) {
        if (decision.status === 'approved') {
          await options.acceptAllPatches()
          if (options.pendingTask.value?.id === decision.taskId) {
            const failure = options.aiError.value || 'Patch 应用未完成。'
            await (await service()).markFailed(decision.id, decision.taskId, failure)
            await options.rejectPatches()
            return
          }
        } else {
          await options.rejectPatches()
        }
        await (await service()).markCompleted(decision.id, decision.taskId)
        return
      }

      if (options.pendingTask.value && options.pendingPatchSet.value) {
        const revisionRequest = await (
          await service()
        ).claimRevisionForTask(options.pendingTask.value.id)
        if (revisionRequest) {
          continuation = {
            previousTaskId: options.pendingTask.value.id,
            feedback: revisionRequest.revisionFeedback ?? '请修订现有提案。',
            previousSummary: revisionRequest.result?.summary ?? '',
            patches: options.pendingPatchSet.value.patches.map((patch) => ({ ...patch })),
          }
          claimedRequest = revisionRequest
          await options.rejectPatches()
        }
      }

      if (options.pendingTask.value) {
        const failedRequest = await (
          await service()
        ).findFailedForTask(options.pendingTask.value.id)
        if (failedRequest) {
          await options.rejectPatches()
          return
        }
      }
      if (!claimedRequest && (options.showPatchModal.value || options.pendingTask.value)) return

      const request = claimedRequest ?? (await (await service()).claimNext())
      if (!request) return
      claimedRequest = request
      await executeRequest(request, continuation)
    } catch (error) {
      if (claimedRequest) {
        await (
          await service()
        ).markFailed(
          claimedRequest.id,
          options.pendingTask.value?.id ?? null,
          error instanceof Error ? error.message : String(error),
        )
      }
      options.notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      polling = false
    }
  }

  async function executeRequest(
    request: AgentCommunicationRequest,
    continuation?: AgentRunContinuation,
  ): Promise<void> {
    const runtimePrompt = toPrompt(request)
    const routedConversationId = request.branchId ?? request.id
    const existingTask = options.conversation.history.value.find(
      (item) => item.id === routedConversationId,
    )
    const routedProjectId = request.projectId ?? existingTask?.projectId
    const detachedProject = options.conversation.projects.value.find(
      (project) => project.id === routedProjectId,
    )
    const detachedMessages = ref<AiConversationMessage[]>(
      existingTask?.messages.map((item) => ({ ...item })) ?? [],
    )
    const detachedError = ref('')
    const detachedConversationId = ref<string | null>(routedConversationId)
    const documentSnapshot = await options.createDocumentSnapshot()

    await options.agentRun.run(runtimePrompt, continuation, {
      mode: ref<AiChatMode>('agent'),
      prompt: ref(runtimePrompt),
      messages: detachedMessages,
      error: detachedError,
      documentSnapshot,
      explicitTargets: ref([]),
      background: true,
      workspace: {
        projectId: ref(detachedProject?.id ?? request.projectId ?? ''),
        projectName: ref(detachedProject?.name ?? '外部 Agent 任务'),
        rootDocumentIds: ref([...(detachedProject?.workspaceRootIds ?? [])]),
        conversationId: detachedConversationId,
        ensureConversationId: () => routedConversationId,
      },
    })
    options.conversation.saveDetachedTask({
      id: routedConversationId,
      projectId: detachedProject?.id ?? request.projectId ?? undefined,
      parentConversationId: request.parentConversationId,
      title: request.branchTitle ?? `A2A · ${request.prompt}`,
      messages: detachedMessages.value,
    })

    const taskId = options.agentRun.lastTaskId.value
    const result = options.agentRun.lastRunReport.value
    if (options.pendingTask.value) {
      await (
        await service()
      ).markAwaitingReview(
        request.id,
        options.pendingTask.value.id,
        result ?? {
          version: 1,
          outcome: 'proposal',
          summary: '已生成待确认修改提案。',
          patchCount: options.pendingPatchSet.value?.patches.length ?? 0,
          targetDocumentIds: Array.from(
            new Set(options.pendingPatchSet.value?.patches.map((patch) => patch.documentId) ?? []),
          ),
        },
      )
      options.showPatchModal.value = false
    } else if (
      options.agentRun.runtimeState.value.status === 'failed' ||
      options.agentRun.runtimeState.value.status === 'cancelled'
    ) {
      await (
        await service()
      ).markFailed(
        request.id,
        taskId,
        options.agentRun.runtimeState.value.detail ||
          (options.agentRun.runtimeState.value.status === 'cancelled'
            ? 'Agent 任务已取消。'
            : 'Agent 任务失败。'),
      )
    } else if (!taskId) {
      await (
        await service()
      ).markFailed(
        request.id,
        null,
        detachedError.value ||
          options.agentRun.lastRunIssue.value ||
          'Agent 请求未创建可追溯任务。',
      )
    } else if (result) {
      await (await service()).markCompleted(request.id, taskId, result)
    } else {
      await (
        await service()
      ).markFailed(request.id, taskId, 'Agent 任务结束但没有返回标准 result。')
    }
  }

  function start(intervalMs = 1_000): void {
    if (timer !== null) return
    void poll()
    timer = globalThis.setInterval(() => void poll(), intervalMs)
  }

  function stop(): void {
    if (timer !== null) globalThis.clearInterval(timer)
    timer = null
  }

  return { poll, start, stop }
}

function toPrompt(request: AgentCommunicationRequest): string {
  const command =
    request.mode === 'learning'
      ? 'learn'
      : request.mode === 'research' || request.mode === 'review'
        ? request.mode
        : null
  return command ? `/${command} ${request.prompt}` : request.prompt
}
