import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface WorkflowScannerSnapshot {
  status: 'stopped' | 'running' | 'paused' | 'degraded'
  lastTickAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  resumedEventWaitCount: number
  resumedSatisfiedWaitCount: number
  automationEnqueuedCount: number
  signalEnqueuedCount: number
  actionRecoveredCount: number
}

export function getWorkflowScannerSnapshot(): Promise<WorkflowScannerSnapshot> {
  return invoke<WorkflowScannerSnapshot>('get_workflow_scanner_snapshot')
}

export function subscribeWorkflowScannerSnapshot(
  listener: (snapshot: WorkflowScannerSnapshot) => void,
): Promise<() => void> {
  return listen<WorkflowScannerSnapshot>('workflow-scanner://status', ({ payload }) =>
    listener(payload),
  )
}
