export type AutomationTriggerType = 'manual' | 'interval' | 'daily'
export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AutomationTriggerSource = 'manual' | 'schedule' | 'retry'

export interface AutomationTriggerConfig {
  intervalMinutes?: number
  dailyTime?: string
}

export interface AutomationTask {
  id: string
  name: string
  instruction: string
  triggerType: AutomationTriggerType
  triggerConfig: AutomationTriggerConfig
  documentId: string | null
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AutomationRun {
  id: string
  automationId: string | null
  automationName?: string
  triggerSource: AutomationTriggerSource
  status: AutomationRunStatus
  inputJson: string
  outputJson: string | null
  error: string | null
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface CreateAutomationInput {
  id: string
  name: string
  instruction: string
  triggerType: AutomationTriggerType
  triggerConfig?: AutomationTriggerConfig
  documentId?: string | null
  enabled?: boolean
  createdAt?: number
}

export function normalizeAutomationTriggerConfig(
  triggerType: AutomationTriggerType,
  config: AutomationTriggerConfig = {},
): AutomationTriggerConfig {
  if (triggerType === 'interval') {
    return {
      intervalMinutes: Math.max(5, Math.min(Math.round(config.intervalMinutes ?? 60), 10_080)),
    }
  }
  if (triggerType === 'daily') {
    return {
      dailyTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(config.dailyTime ?? '')
        ? config.dailyTime
        : '09:00',
    }
  }
  return {}
}

export function calculateNextAutomationRun(
  triggerType: AutomationTriggerType,
  config: AutomationTriggerConfig,
  from: number,
): number | null {
  if (triggerType === 'manual') return null
  const normalized = normalizeAutomationTriggerConfig(triggerType, config)
  if (triggerType === 'interval') {
    return from + (normalized.intervalMinutes ?? 60) * 60_000
  }
  const [hour, minute] = (normalized.dailyTime ?? '09:00').split(':').map(Number)
  const next = new Date(from)
  next.setHours(hour ?? 9, minute ?? 0, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}
