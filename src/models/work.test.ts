import { describe, expect, it } from 'vitest'

import { canTransitionTaskRun, getTaskRunTransitionError } from './work'

describe('task run transition policy', () => {
  it('supports ordinary execution and verification transitions', () => {
    expect(canTransitionTaskRun('queued', 'running')).toBe(true)
    expect(canTransitionTaskRun('running', 'waiting_approval')).toBe(true)
    expect(canTransitionTaskRun('blocked', 'completed')).toBe(true)
    expect(canTransitionTaskRun('waiting_approval', 'blocked')).toBe(true)
  })

  it('rejects terminal rewinds', () => {
    expect(canTransitionTaskRun('completed', 'running')).toBe(false)
    expect(getTaskRunTransitionError('completed', 'running')).toContain(
      '不允许从 completed 转换为 running',
    )
  })
})
