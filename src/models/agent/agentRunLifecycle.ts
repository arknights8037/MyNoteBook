export type AgentRunPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'waiting_user'
  | 'waiting_external'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentPlanStepType =
  | 'reason'
  | 'tool'
  | 'delegate'
  | 'approval'
  | 'write'
  | 'respond'
  | 'finalize'

export type AgentPlanStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked'

export interface AgentPlanStep {
  id: string
  type: AgentPlanStepType
  status: AgentPlanStepStatus
  dependsOn: string[]
  input: unknown
  output?: unknown
  error?: string
}

export interface AgentPendingApproval {
  id: string
  stepId: string | null
  question: string
}

export interface AgentRunLifecycleState {
  id: string | null
  goal: string
  phase: AgentRunPhase
  plan: AgentPlanStep[]
  currentStepId: string | null
  pendingApproval: AgentPendingApproval | null
  activeToolCallId: string | null
  error: string | null
  startedAt: number | null
  completedAt: number | null
}

interface AgentRunEventBase {
  occurredAt: number
}

export type AgentRunEvent =
  | (AgentRunEventBase & { type: 'TaskCreated'; runId: string; goal: string })
  | (AgentRunEventBase & { type: 'PlanGenerated'; steps: AgentPlanStep[] })
  | (AgentRunEventBase & { type: 'StepStarted'; stepId: string })
  | (AgentRunEventBase & { type: 'StepSucceeded'; stepId: string; output?: unknown })
  | (AgentRunEventBase & { type: 'StepFailed'; stepId: string; error: string })
  | (AgentRunEventBase & {
      type: 'ToolCallRequested'
      stepId: string | null
      toolCallId: string
    })
  | (AgentRunEventBase & { type: 'ToolCallSucceeded'; toolCallId: string })
  | (AgentRunEventBase & { type: 'ToolCallFailed'; toolCallId: string; error: string })
  | (AgentRunEventBase & {
      type: 'ApprovalRequested'
      approvalId: string
      stepId: string | null
      question: string
    })
  | (AgentRunEventBase & { type: 'ApprovalGranted'; approvalId: string })
  | (AgentRunEventBase & { type: 'ApprovalRejected'; approvalId: string; reason: string })
  | (AgentRunEventBase & { type: 'ExternalWaitStarted'; stepId: string | null })
  | (AgentRunEventBase & { type: 'ExternalWaitFinished'; stepId: string | null })
  | (AgentRunEventBase & { type: 'RunCompleted' })
  | (AgentRunEventBase & { type: 'RunFailed'; error: string })
  | (AgentRunEventBase & { type: 'RunCancelled' })

export type AgentRunScheduleAction =
  | { type: 'WAIT'; reason: 'user' | 'external' }
  | { type: 'EXECUTE_STEP'; stepId: string }
  | { type: 'COMPLETE' }
  | { type: 'BLOCKED' }
  | { type: 'STOP' }

export function createIdleAgentRunLifecycle(): AgentRunLifecycleState {
  return {
    id: null,
    goal: '',
    phase: 'idle',
    plan: [],
    currentStepId: null,
    pendingApproval: null,
    activeToolCallId: null,
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

export function reduceAgentRunEvent(
  state: AgentRunLifecycleState,
  event: AgentRunEvent,
): AgentRunLifecycleState {
  switch (event.type) {
    case 'TaskCreated':
      return {
        ...createIdleAgentRunLifecycle(),
        id: event.runId,
        goal: event.goal,
        phase: 'planning',
        startedAt: event.occurredAt,
      }
    case 'PlanGenerated':
      return { ...state, phase: 'planning', plan: event.steps.map(cloneStep) }
    case 'StepStarted':
      return updateStep(state, event.stepId, (step) => ({ ...step, status: 'running' }), {
        currentStepId: event.stepId,
        phase: stepPhase(state.plan, event.stepId),
      })
    case 'StepSucceeded':
      return updateStep(
        state,
        event.stepId,
        (step) => ({ ...step, status: 'succeeded', output: event.output }),
        { currentStepId: state.currentStepId === event.stepId ? null : state.currentStepId },
      )
    case 'StepFailed':
      return updateStep(
        state,
        event.stepId,
        (step) => ({ ...step, status: 'failed', error: event.error }),
        { currentStepId: null, error: event.error },
      )
    case 'ToolCallRequested':
      return {
        ...state,
        phase: 'executing',
        currentStepId: event.stepId ?? state.currentStepId,
        activeToolCallId: event.toolCallId,
      }
    case 'ToolCallSucceeded':
      return {
        ...state,
        activeToolCallId:
          state.activeToolCallId === event.toolCallId ? null : state.activeToolCallId,
      }
    case 'ToolCallFailed':
      return {
        ...state,
        activeToolCallId:
          state.activeToolCallId === event.toolCallId ? null : state.activeToolCallId,
        error: event.error,
      }
    case 'ApprovalRequested':
      return {
        ...state,
        phase: 'waiting_user',
        pendingApproval: {
          id: event.approvalId,
          stepId: event.stepId,
          question: event.question,
        },
      }
    case 'ApprovalGranted':
      if (state.pendingApproval?.id !== event.approvalId) return state
      return { ...state, phase: 'executing', pendingApproval: null }
    case 'ApprovalRejected':
      if (state.pendingApproval?.id !== event.approvalId) return state
      return { ...state, phase: 'executing', pendingApproval: null, error: event.reason }
    case 'ExternalWaitStarted':
      return { ...state, phase: 'waiting_external', currentStepId: event.stepId }
    case 'ExternalWaitFinished':
      return { ...state, phase: 'executing', currentStepId: event.stepId }
    case 'RunCompleted':
      return terminalState(state, 'completed', event.occurredAt, null)
    case 'RunFailed':
      return terminalState(state, 'failed', event.occurredAt, event.error)
    case 'RunCancelled':
      return terminalState(state, 'cancelled', event.occurredAt, null)
  }
}

export function scheduleAgentRun(state: AgentRunLifecycleState): AgentRunScheduleAction {
  if (state.phase === 'waiting_user') return { type: 'WAIT', reason: 'user' }
  if (state.phase === 'waiting_external') return { type: 'WAIT', reason: 'external' }
  if (isTerminalPhase(state.phase)) return { type: 'STOP' }

  const running = state.plan.find((step) => step.status === 'running')
  if (running) return { type: 'EXECUTE_STEP', stepId: running.id }

  const succeeded = new Set(
    state.plan.filter((step) => step.status === 'succeeded').map((step) => step.id),
  )
  const runnable = state.plan.find(
    (step) =>
      step.status === 'pending' && step.dependsOn.every((dependency) => succeeded.has(dependency)),
  )
  if (runnable) return { type: 'EXECUTE_STEP', stepId: runnable.id }
  if (state.plan.length > 0 && state.plan.every((step) => step.status === 'succeeded')) {
    return { type: 'COMPLETE' }
  }
  return { type: 'BLOCKED' }
}

function cloneStep(step: AgentPlanStep): AgentPlanStep {
  return { ...step, dependsOn: [...step.dependsOn] }
}

function updateStep(
  state: AgentRunLifecycleState,
  stepId: string,
  update: (step: AgentPlanStep) => AgentPlanStep,
  stateUpdate: Partial<AgentRunLifecycleState>,
): AgentRunLifecycleState {
  return {
    ...state,
    ...stateUpdate,
    plan: state.plan.map((step) => (step.id === stepId ? update(step) : step)),
  }
}

function stepPhase(plan: AgentPlanStep[], stepId: string): AgentRunPhase {
  return plan.find((step) => step.id === stepId)?.type === 'reason' ? 'planning' : 'executing'
}

function terminalState(
  state: AgentRunLifecycleState,
  phase: 'completed' | 'failed' | 'cancelled',
  completedAt: number,
  error: string | null,
): AgentRunLifecycleState {
  return {
    ...state,
    phase,
    currentStepId: null,
    pendingApproval: null,
    activeToolCallId: null,
    error,
    completedAt,
  }
}

function isTerminalPhase(phase: AgentRunPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}
