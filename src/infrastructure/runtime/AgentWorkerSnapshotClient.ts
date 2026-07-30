import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { AgentWorkerAuthorizationRequest } from '@/models/agent/agentRuntimeContract'

export interface AgentWorkerSnapshot {
  status: 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'unavailable'
  supervisorInstanceId: string
  workerInstanceId: string | null
  pid: number | null
  activeRunIds: string[]
  activeRuns: Array<{
    runId: string
    workItemId: string
    sessionId: string
    workflowId: string | null
    objective: string
    intent: string
  }>
  pendingAuthorizations: AgentWorkerAuthorizationRequest[]
  pendingTerminals: Array<{
    runId: string
    workItemId: string
    sessionId: string
    workflowId: string | null
    objective: string
    intent: string
    terminalType: 'run.result' | 'run.error'
    recoverable: boolean
  }>
  lastHeartbeatAt: number | null
  restartCount: number
  lastError: string | null
}

export function getAgentWorkerSnapshot(): Promise<AgentWorkerSnapshot> {
  return invoke<AgentWorkerSnapshot>('get_agent_worker_snapshot')
}

export function subscribeAgentWorkerSnapshot(
  listener: (snapshot: AgentWorkerSnapshot) => void,
): Promise<() => void> {
  return listen<AgentWorkerSnapshot>('agent-runtime://worker-status', ({ payload }) =>
    listener(payload),
  )
}
