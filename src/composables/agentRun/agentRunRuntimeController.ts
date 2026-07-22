import { ref } from 'vue'

import type { AgentTask } from '@/models/agent/agent'
import {
  createIdleAgentRunLifecycle,
  type AgentPlanStep,
  type AgentRunEvent,
  type AgentRunLifecycleState,
} from '@/models/agent/agentRunLifecycle'
import {
  createIdleAgentRuntimeState,
  type AgentAuthorizationRequest,
  type AgentRuntimeViewPhase,
  type AgentRuntimeViewState,
} from '@/models/agent/agentRuntime'
import { AgentRunEngine } from '@/services/agent/AgentRunEngine'
import type { AgentProgressUpdate } from '@/services/agent/AgentRuntime'

const PREPARE_STEP_ID = 'prepare'
const EXECUTE_STEP_ID = 'execute'
const FINALIZE_STEP_ID = 'finalize'

export function createAgentRunRuntimeController(createId: () => string) {
  let pendingAuthorization: {
    request: AgentAuthorizationRequest
    resolve: (answer: string) => void
    reject: (error: Error) => void
  } | null = null
  const runtimeState = ref<AgentRuntimeViewState>(createIdleAgentRuntimeState())
  const lifecycleState = ref<AgentRunLifecycleState>(createIdleAgentRunLifecycle())
  const runEvents = ref<AgentRunEvent[]>([])
  const engine = new AgentRunEngine(Date.now, (event, state) => {
    lifecycleState.value = cloneLifecycleState(state)
    runEvents.value = [...runEvents.value, event]
    runtimeState.value.lifecycle = cloneLifecycleState(state)
    runtimeState.value.runEvents = [...runEvents.value]
    runtimeState.value.status = projectViewStatus(state)
    runtimeState.value.startedAt = state.startedAt
    runtimeState.value.completedAt = state.completedAt
  })

  function start(input: { runId: string; goal: string; detail: string }): void {
    cancelPendingAuthorization('新的 Agent 任务已经开始。')
    engine.reset()
    runEvents.value = []
    runtimeState.value = {
      ...createIdleAgentRuntimeState(),
      status: 'running',
      phase: 'preparing',
      detail: input.detail,
    }
    engine.dispatch({ type: 'CREATE_RUN', runId: input.runId, goal: input.goal })
    engine.dispatch({ type: 'SET_PLAN', steps: createDefaultPlan(input.goal) })
    engine.dispatch({ type: 'START_STEP', stepId: PREPARE_STEP_ID })
  }

  function beginExecution(detail: string): void {
    completeStepIfRunning(PREPARE_STEP_ID)
    startStepIfPending(EXECUTE_STEP_ID)
    runtimeState.value.phase = 'planning'
    runtimeState.value.detail = detail
  }

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
    engine.dispatch({
      type: 'REQUEST_APPROVAL',
      approvalId: authorizationRequest.id,
      stepId: lifecycleState.value.currentStepId,
      question: request.question,
    })
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
    engine.dispatch({ type: 'GRANT_APPROVAL', approvalId: requestId })
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
    engine.dispatch({
      type: 'REJECT_APPROVAL',
      approvalId: pending.request.id,
      reason: message,
    })
    runtimeState.value.authorizationRequest = null
    pending.reject(Object.assign(new Error(message), { name: 'AbortError' }))
  }

  function applyProgressUpdate(update: AgentProgressUpdate): void {
    runtimeState.value.phase = update.phase
    runtimeState.value.detail = update.detail
    if (update.phase === 'finalizing') startFinalizing()
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

    const call = update.toolCall
    if (call.status === 'running' || call.status === 'pending') {
      if (lifecycleState.value.activeToolCallId !== call.id) {
        engine.dispatch({
          type: 'REQUEST_TOOL',
          stepId: lifecycleState.value.currentStepId,
          toolCallId: call.id,
        })
      }
    } else if (call.status === 'completed') {
      engine.dispatch({ type: 'COMPLETE_TOOL', toolCallId: call.id })
    } else if (call.status === 'failed' || call.status === 'rejected') {
      engine.dispatch({
        type: 'FAIL_TOOL',
        toolCallId: call.id,
        error: call.error || `工具 ${call.toolName} 未完成。`,
      })
    }

    const index = runtimeState.value.toolCalls.findIndex((candidate) => candidate.id === call.id)
    if (index >= 0) runtimeState.value.toolCalls[index] = call
    else runtimeState.value.toolCalls.push(call)
  }

  function recordExecutionResult(input: {
    rounds: number
    toolCalls: AgentRuntimeViewState['toolCalls']
  }): void {
    runtimeState.value.rounds = input.rounds
    runtimeState.value.toolCalls = input.toolCalls
  }

  function setSummary(summary: string): void {
    runtimeState.value.summary = summary
  }

  function complete(detail: string): void {
    startFinalizing()
    completeStepIfRunning(FINALIZE_STEP_ID)
    engine.dispatch({ type: 'COMPLETE_RUN' })
    runtimeState.value.phase = 'completed'
    runtimeState.value.detail = detail
    runtimeState.value.authorizationRequest = null
    settleRunningTimelineEvents('completed')
    appendTimelineStatus('completed', detail)
  }

  function fail(error: string): void {
    failCurrentStep(error)
    engine.dispatch({ type: 'FAIL_RUN', error })
    runtimeState.value.phase = 'failed'
    runtimeState.value.detail = error
    runtimeState.value.authorizationRequest = null
    settleRunningTimelineEvents('failed')
    appendTimelineStatus('failed', error)
    runtimeState.value.summary ||= error
  }

  function cancel(detail = '任务已停止'): void {
    engine.dispatch({ type: 'CANCEL_RUN' })
    runtimeState.value.phase = 'cancelled'
    runtimeState.value.detail = detail
    runtimeState.value.authorizationRequest = null
    settleRunningTimelineEvents('completed')
    appendTimelineStatus('completed', detail)
    runtimeState.value.summary ||= detail
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
    engine.reset()
    lifecycleState.value = createIdleAgentRunLifecycle()
    runEvents.value = []
    runtimeState.value = createIdleAgentRuntimeState()
  }

  function startFinalizing(): void {
    completeStepIfRunning(EXECUTE_STEP_ID)
    startStepIfPending(FINALIZE_STEP_ID)
  }

  function startStepIfPending(stepId: string): void {
    const step = lifecycleState.value.plan.find((candidate) => candidate.id === stepId)
    if (step?.status === 'pending') engine.dispatch({ type: 'START_STEP', stepId })
  }

  function completeStepIfRunning(stepId: string): void {
    const step = lifecycleState.value.plan.find((candidate) => candidate.id === stepId)
    if (step?.status === 'running') engine.dispatch({ type: 'COMPLETE_STEP', stepId })
  }

  function failCurrentStep(error: string): void {
    const stepId = lifecycleState.value.currentStepId
    if (stepId) engine.dispatch({ type: 'FAIL_STEP', stepId, error })
  }

  return {
    runtimeState,
    lifecycleState,
    runEvents,
    start,
    beginExecution,
    waitForAuthorizerInput,
    answerAuthorization,
    cancelPendingAuthorization,
    applyProgressUpdate,
    recordExecutionResult,
    setSummary,
    complete,
    fail,
    cancel,
    schedule: () => engine.schedule(),
    reset,
  }
}

function createDefaultPlan(goal: string): AgentPlanStep[] {
  return [
    {
      id: PREPARE_STEP_ID,
      type: 'reason',
      status: 'pending',
      dependsOn: [],
      input: { goal },
    },
    {
      id: EXECUTE_STEP_ID,
      type: 'tool',
      status: 'pending',
      dependsOn: [PREPARE_STEP_ID],
      input: { goal },
    },
    {
      id: FINALIZE_STEP_ID,
      type: 'finalize',
      status: 'pending',
      dependsOn: [EXECUTE_STEP_ID],
      input: { goal },
    },
  ]
}

function projectViewStatus(state: AgentRunLifecycleState): AgentRuntimeViewState['status'] {
  switch (state.phase) {
    case 'idle':
      return 'idle'
    case 'waiting_user':
      return 'waiting_authorizer'
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state.phase
    default:
      return 'running'
  }
}

function cloneLifecycleState(state: AgentRunLifecycleState): AgentRunLifecycleState {
  return {
    ...state,
    plan: state.plan.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })),
    pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
  }
}

export function projectLifecyclePhaseToViewPhase(
  state: AgentRunLifecycleState,
): AgentRuntimeViewPhase {
  switch (state.phase) {
    case 'planning':
      return 'planning'
    case 'waiting_user':
      return 'waiting_authorizer'
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state.phase
    default:
      return state.activeToolCallId ? 'tool_running' : 'preparing'
  }
}
