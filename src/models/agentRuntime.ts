import type { AgentToolCall } from './agentTool'

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

export interface AgentRuntimeViewState {
  status: AgentRuntimeViewStatus
  phase: AgentRuntimeViewPhase
  detail: string
  startedAt: number | null
  completedAt: number | null
  rounds: number
  toolCalls: AgentToolCall[]
  authorizationRequest: AgentAuthorizationRequest | null
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
    authorizationRequest: null,
  }
}
