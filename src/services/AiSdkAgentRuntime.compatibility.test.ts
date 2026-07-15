import { describe, expect, it } from 'vitest'

import { isToolCompatibilityError } from './AiSdkAgentRuntime'

describe('AI SDK agent compatibility errors', () => {
  it('recognizes thinking-mode tool_choice rejections', () => {
    expect(
      isToolCompatibilityError(new Error('Thinking mode does not support this tool_choice')),
    ).toBe(true)
  })

  it('does not hide unrelated provider errors', () => {
    expect(isToolCompatibilityError(new Error('Invalid API key'))).toBe(false)
  })
})
