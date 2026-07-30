import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface WorkflowTimerSnapshot {
  status: 'stopped' | 'running' | 'paused' | 'degraded'
  lastTickAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  scheduledCount: number
  processingCount: number
  retryCount: number
  dueCount: number
  deadLetterCount: number
  maxLagMs: number
}

export function getWorkflowTimerSnapshot(): Promise<WorkflowTimerSnapshot> {
  return invoke<WorkflowTimerSnapshot>('get_workflow_timer_snapshot')
}

export function subscribeWorkflowTimerSnapshot(
  listener: (snapshot: WorkflowTimerSnapshot) => void,
): Promise<() => void> {
  return listen<WorkflowTimerSnapshot>('workflow-timer://status', ({ payload }) =>
    listener(payload),
  )
}
