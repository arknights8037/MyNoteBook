import { describe, expect, it } from 'vitest'

import { calculateNextAutomationRun, normalizeAutomationTriggerConfig } from '@/models/automation/automation'

describe('automation schedules', () => {
  it('bounds interval schedules and calculates the next run', () => {
    expect(normalizeAutomationTriggerConfig('interval', { intervalMinutes: 1 })).toEqual({
      intervalMinutes: 5,
    })
    expect(calculateNextAutomationRun('interval', { intervalMinutes: 15 }, 1_000)).toBe(901_000)
  })

  it('rolls a daily schedule to the next day when its time already passed', () => {
    const from = new Date(2026, 6, 13, 10, 0, 0).getTime()
    const next = calculateNextAutomationRun('daily', { dailyTime: '09:30' }, from)
    expect(next).toBe(new Date(2026, 6, 14, 9, 30, 0).getTime())
  })

  it('does not schedule manual tasks', () => {
    expect(calculateNextAutomationRun('manual', {}, Date.now())).toBeNull()
  })
})
