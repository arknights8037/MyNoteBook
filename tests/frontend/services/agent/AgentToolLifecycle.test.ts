import { describe, expect, it } from 'vitest'

import {
  createToolCallSignature,
  getToolProgressLabel,
  normalizeAbortError,
  waitForRetry,
} from '@/services/agent/AgentToolLifecycle'

describe('AgentToolLifecycle', () => {
  it('creates stable signatures independent of object key order', () => {
    expect(createToolCallSignature('read', { b: 2, a: 1 })).toBe(
      createToolCallSignature('read', { a: 1, b: 2 }),
    )
    expect(getToolProgressLabel('read_document', true)).toBe('已读取相关资料')
  })

  it('normalizes an already aborted retry to AbortError', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => waitForRetry(10, controller.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    )
    expect(normalizeAbortError(undefined).name).toBe('AbortError')
  })
})
