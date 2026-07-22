import { describe, expect, it } from 'vitest'

import { createDefaultExecutionPolicy, normalizeExecutionPolicy } from '@/models/agent/executionPolicy'

describe('executionPolicy', () => {
  it('allows production agent runs well beyond six tool rounds', () => {
    const policy = createDefaultExecutionPolicy({ tokenBudget: 8_000, allowedTools: ['search'] })

    expect(policy.maxToolRounds).toBe(48)
    expect(policy.maxToolFailures).toBe(10)
    expect(policy.maxDurationMs).toBe(15 * 60 * 1000)
    expect(policy.maxRetries).toBe(4)
  })

  it('keeps a hard upper bound for persisted or imported policies', () => {
    const policy = createDefaultExecutionPolicy({ tokenBudget: 8_000, allowedTools: ['search'] })

    expect(normalizeExecutionPolicy({ ...policy, maxToolRounds: 999 }).maxToolRounds).toBe(96)
    expect(normalizeExecutionPolicy({ ...policy, maxToolFailures: 999 }).maxToolFailures).toBe(20)
  })
})
