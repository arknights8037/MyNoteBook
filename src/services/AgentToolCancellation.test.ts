import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { runCancellableAgentInvoke } from './AgentToolCancellation'

describe('Agent tool cancellation', () => {
  beforeEach(() => invoke.mockClear())

  it('notifies the native cancellation registry and rejects with AbortError', async () => {
    const controller = new AbortController()
    const operation = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5))
    const result = runCancellableAgentInvoke('call-1', controller.signal, () => operation)

    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).toHaveBeenCalledWith('cancel_agent_tool_call', {
      input: { callId: 'call-1' },
    })
  })
})
