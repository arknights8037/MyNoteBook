import { describe, expect, it } from 'vitest'

import { createDefaultExecutionPolicy, normalizeExecutionPolicy } from './executionPolicy'

describe('executionPolicy', () => {
  it('allows production agent runs well beyond six tool rounds', () => {
    const policy = createDefaultExecutionPolicy({ tokenBudget: 8_000, allowedTools: ['search'] })

    expect(policy.maxToolRounds).toBe(32)
    expect(policy.maxToolFailures).toBe(6)
    expect(policy.maxDurationMs).toBe(10 * 60 * 1000)
  })

  it('keeps a hard upper bound for persisted or imported policies', () => {
    const policy = createDefaultExecutionPolicy({ tokenBudget: 8_000, allowedTools: ['search'] })

    expect(normalizeExecutionPolicy({ ...policy, maxToolRounds: 999 }).maxToolRounds).toBe(64)
  })
})
