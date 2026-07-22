import {
  createIdleAgentRunLifecycle,
  reduceAgentRunEvent,
  scheduleAgentRun,
  type AgentPlanStep,
  type AgentRunEvent,
  type AgentRunLifecycleState,
  type AgentRunScheduleAction,
} from '@/models/agent/agentRunLifecycle'

export type AgentRunCommand =
  | { type: 'CREATE_RUN'; runId: string; goal: string }
  | { type: 'SET_PLAN'; steps: AgentPlanStep[] }
  | { type: 'START_STEP'; stepId: string }
  | { type: 'COMPLETE_STEP'; stepId: string; output?: unknown }
  | { type: 'FAIL_STEP'; stepId: string; error: string }
  | { type: 'REQUEST_TOOL'; stepId: string | null; toolCallId: string }
  | { type: 'COMPLETE_TOOL'; toolCallId: string }
  | { type: 'FAIL_TOOL'; toolCallId: string; error: string }
  | { type: 'REQUEST_APPROVAL'; approvalId: string; stepId: string | null; question: string }
  | { type: 'GRANT_APPROVAL'; approvalId: string }
  | { type: 'REJECT_APPROVAL'; approvalId: string; reason: string }
  | { type: 'START_EXTERNAL_WAIT'; stepId: string | null }
  | { type: 'FINISH_EXTERNAL_WAIT'; stepId: string | null }
  | { type: 'COMPLETE_RUN' }
  | { type: 'FAIL_RUN'; error: string }
  | { type: 'CANCEL_RUN' }

export class AgentRunEngine {
  private currentState = createIdleAgentRunLifecycle()
  private readonly eventHistory: AgentRunEvent[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onEvent?: (event: AgentRunEvent, state: AgentRunLifecycleState) => void,
  ) {}

  get state(): AgentRunLifecycleState {
    return this.currentState
  }

  get events(): readonly AgentRunEvent[] {
    return this.eventHistory
  }

  dispatch(command: AgentRunCommand): AgentRunLifecycleState {
    for (const event of decideAgentRunEvents(command, this.now())) {
      this.eventHistory.push(event)
      this.currentState = reduceAgentRunEvent(this.currentState, event)
      this.onEvent?.(event, this.currentState)
    }
    return this.currentState
  }

  schedule(): AgentRunScheduleAction {
    return scheduleAgentRun(this.currentState)
  }

  reset(): void {
    this.currentState = createIdleAgentRunLifecycle()
    this.eventHistory.length = 0
  }
}

export function decideAgentRunEvents(command: AgentRunCommand, occurredAt: number): AgentRunEvent[] {
  switch (command.type) {
    case 'CREATE_RUN':
      return [{ type: 'TaskCreated', runId: command.runId, goal: command.goal, occurredAt }]
    case 'SET_PLAN':
      return [{ type: 'PlanGenerated', steps: command.steps, occurredAt }]
    case 'START_STEP':
      return [{ type: 'StepStarted', stepId: command.stepId, occurredAt }]
    case 'COMPLETE_STEP':
      return [{ type: 'StepSucceeded', stepId: command.stepId, output: command.output, occurredAt }]
    case 'FAIL_STEP':
      return [{ type: 'StepFailed', stepId: command.stepId, error: command.error, occurredAt }]
    case 'REQUEST_TOOL':
      return [
        {
          type: 'ToolCallRequested',
          stepId: command.stepId,
          toolCallId: command.toolCallId,
          occurredAt,
        },
      ]
    case 'COMPLETE_TOOL':
      return [{ type: 'ToolCallSucceeded', toolCallId: command.toolCallId, occurredAt }]
    case 'FAIL_TOOL':
      return [
        {
          type: 'ToolCallFailed',
          toolCallId: command.toolCallId,
          error: command.error,
          occurredAt,
        },
      ]
    case 'REQUEST_APPROVAL':
      return [
        {
          type: 'ApprovalRequested',
          approvalId: command.approvalId,
          stepId: command.stepId,
          question: command.question,
          occurredAt,
        },
      ]
    case 'GRANT_APPROVAL':
      return [{ type: 'ApprovalGranted', approvalId: command.approvalId, occurredAt }]
    case 'REJECT_APPROVAL':
      return [
        {
          type: 'ApprovalRejected',
          approvalId: command.approvalId,
          reason: command.reason,
          occurredAt,
        },
      ]
    case 'START_EXTERNAL_WAIT':
      return [{ type: 'ExternalWaitStarted', stepId: command.stepId, occurredAt }]
    case 'FINISH_EXTERNAL_WAIT':
      return [{ type: 'ExternalWaitFinished', stepId: command.stepId, occurredAt }]
    case 'COMPLETE_RUN':
      return [{ type: 'RunCompleted', occurredAt }]
    case 'FAIL_RUN':
      return [{ type: 'RunFailed', error: command.error, occurredAt }]
    case 'CANCEL_RUN':
      return [{ type: 'RunCancelled', occurredAt }]
  }
}
