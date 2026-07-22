import type { AgentToolCall } from '@/models/agent/agentTool'
import type { AgentRunEvent, AgentRunLifecycleState } from '@/models/agent/agentRunLifecycle'

export interface AgentAuthorizationRequest {
  id: string
  question: string
  context: string
  options: string[]
  allowFreeText: boolean
}

export type AgentRuntimeViewStatus =
  | 'idle'
  | 'running'
  | 'waiting_authorizer'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentRuntimeViewPhase =
  | 'preparing'
  | 'planning'
  | 'tool_running'
  | 'tool_completed'
  | 'waiting_authorizer'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentTimelineEventKind =
  | 'status'
  | 'decision'
  | 'summary'
  | 'step_started'
  | 'step_completed'
  | 'tool'
  | 'retry'

export type AgentTimelineEventStatus = 'running' | 'completed' | 'failed'

export interface AgentTimelineEvent {
  id: string
  kind: AgentTimelineEventKind
  status: AgentTimelineEventStatus
  detail: string
  occurredAt: number
  completedAt: number | null
  stepNumber?: number
  toolCallId?: string
}

export interface AgentRuntimeViewState {
  status: AgentRuntimeViewStatus
  phase: AgentRuntimeViewPhase
  detail: string
  startedAt: number | null
  completedAt: number | null
  rounds: number
  toolCalls: AgentToolCall[]
  timelineEvents: AgentTimelineEvent[]
  authorizationRequest: AgentAuthorizationRequest | null
  summary?: string
  lifecycle: AgentRunLifecycleState
  runEvents: AgentRunEvent[]
}

export function createIdleAgentRuntimeState(): AgentRuntimeViewState {
  return {
    status: 'idle',
    phase: 'preparing',
    detail: '',
    startedAt: null,
    completedAt: null,
    rounds: 0,
    toolCalls: [],
    timelineEvents: [],
    authorizationRequest: null,
    summary: '',
    lifecycle: {
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
    },
    runEvents: [],
  }
}
