import { describe, expect, it } from 'vitest'

import { COGNITIVE_TEST_OUTPUT_CONTRACT } from './CognitiveRegistry'
import { validateAgentOutputContract } from './AgentOutputContract'

describe('AgentOutputContract', () => {
  it('validates a cognitive JSON contract independently from the legacy patch protocol', () => {
    expect(
      validateAgentOutputContract(
        COGNITIVE_TEST_OUTPUT_CONTRACT,
        '```json\n{"summary":"完成","items":[{"kind":"claim","text":"结论"}]}\n```',
      ),
    ).toEqual({ summary: '完成', items: [{ kind: 'claim', text: '结论' }] })
    expect(() =>
      validateAgentOutputContract(COGNITIVE_TEST_OUTPUT_CONTRACT, '{"commands":[]}'),
    ).toThrow()
  })
})
