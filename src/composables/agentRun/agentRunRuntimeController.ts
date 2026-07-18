import { ref } from 'vue'

import type { AgentTask } from '@/models/agent'
import {
  createIdleAgentRuntimeState,
  type AgentAuthorizationRequest,
  type AgentRuntimeViewState,
} from '@/models/agentRuntime'
import type { AgentProgressUpdate } from '@/services/AgentRuntime'

export function createAgentRunRuntimeController(createId: () => string) {
  let pendingAuthorization: {
    request: AgentAuthorizationRequest
    resolve: (answer: string) => void
    reject: (error: Error) => void
  } | null = null
  const runtimeState = ref<AgentRuntimeViewState>(createIdleAgentRuntimeState())

  function waitForAuthorizerInput(
    request: Omit<AgentAuthorizationRequest, 'id'>,
    task: AgentTask,
  ): Promise<string> {
    cancelPendingAuthorization('Agent 提出了新的授权问题。')
    const authorizationRequest: AgentAuthorizationRequest = {
      ...request,
      id: createId(),
      options: request.options.slice(0, 5),
    }
    task.currentStep = '等待授权人回答'
    runtimeState.value.status = 'waiting_authorizer'
    runtimeState.value.phase = 'waiting_authorizer'
    runtimeState.value.detail = '等待授权人回答'
    runtimeState.value.authorizationRequest = authorizationRequest
    runtimeState.value.timelineEvents.push({
      id: `authorization:${authorizationRequest.id}`,
      kind: 'status',
      status: 'running',
      detail: request.question,
      occurredAt: Date.now(),
      completedAt: null,
    })
    return new Promise<string>((resolve, reject) => {
      pendingAuthorization = { request: authorizationRequest, resolve, reject }
    })
  }

  function answerAuthorization(requestId: string, answer: string): boolean {
    const pending = pendingAuthorization
    const normalized = answer.trim()
    if (!pending || pending.request.id !== requestId || !normalized) return false
    if (
      !pending.request.allowFreeText &&
      pending.request.options.length > 0 &&
      !pending.request.options.includes(normalized)
    ) {
      return false
    }
    pendingAuthorization = null
    runtimeState.value.status = 'running'
    runtimeState.value.phase = 'tool_running'
    runtimeState.value.detail = '已收到授权人回答，继续执行'
    runtimeState.value.authorizationRequest = null
    const authorizationEvent = runtimeState.value.timelineEvents.find(
      (event) => event.id === `authorization:${requestId}`,
    )
    if (authorizationEvent) {
      authorizationEvent.status = 'completed'
      authorizationEvent.detail = '已收到授权人回答，继续执行'
      authorizationEvent.completedAt = Date.now()
    }
    pending.resolve(normalized)
    return true
  }

  function cancelPendingAuthorization(message: string): void {
    if (!pendingAuthorization) return
    const pending = pendingAuthorization
    pendingAuthorization = null
    runtimeState.value.authorizationRequest = null
    pending.reject(Object.assign(new Error(message), { name: 'AbortError' }))
  }

  function applyProgressUpdate(update: AgentProgressUpdate): void {
    runtimeState.value.phase = update.phase
    runtimeState.value.detail = update.detail
    if (update.timelineEvent) {
      const timelineIndex = runtimeState.value.timelineEvents.findIndex(
        (event) => event.id === update.timelineEvent?.id,
      )
      if (timelineIndex >= 0) runtimeState.value.timelineEvents[timelineIndex] = update.timelineEvent
      else runtimeState.value.timelineEvents.push(update.timelineEvent)
      if (update.timelineEvent.stepNumber) {
        runtimeState.value.rounds = Math.max(
          runtimeState.value.rounds,
          update.timelineEvent.stepNumber,
        )
      }
    }
    if (!update.toolCall) return

    const index = runtimeState.value.toolCalls.findIndex((call) => call.id === update.toolCall?.id)
    if (index >= 0) runtimeState.value.toolCalls[index] = update.toolCall
    else runtimeState.value.toolCalls.push(update.toolCall)
  }

  function appendTimelineStatus(
    status: 'running' | 'completed' | 'failed',
    detail: string,
  ): void {
    const occurredAt = Date.now()
    runtimeState.value.timelineEvents.push({
      id: `status:${createId()}`,
      kind: 'status',
      status,
      detail,
      occurredAt,
      completedAt: status === 'running' ? null : occurredAt,
    })
  }

  function settleRunningTimelineEvents(status: 'completed' | 'failed'): void {
    const completedAt = Date.now()
    for (const event of runtimeState.value.timelineEvents) {
      if (event.status !== 'running') continue
      event.status = status
      event.completedAt = completedAt
    }
  }

  function reset(): void {
    cancelPendingAuthorization('Agent Runtime 已重置。')
    runtimeState.value = createIdleAgentRuntimeState()
  }

  return {
    runtimeState,
    waitForAuthorizerInput,
    answerAuthorization,
    cancelPendingAuthorization,
    applyProgressUpdate,
    appendTimelineStatus,
    settleRunningTimelineEvents,
    reset,
  }
}
