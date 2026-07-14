import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invoke } from '@tauri-apps/api/core'
import { proxyAiFetch } from './AiHttpService'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class<T> {
    onmessage: (message: T) => void = () => undefined
  },
}))

describe('AiHttpService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(invoke).mockReset()
  })

  it('streams provider response chunks through the Tauri channel', async () => {
    let releaseLastChunk!: () => void
    const lastChunk = new Promise<void>((resolve) => {
      releaseLastChunk = resolve
    })
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const channel = args?.onEvent as {
        onmessage: (message: unknown) => void
      }
      channel.onmessage({
        event: 'started',
        data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
      })
      channel.onmessage({ event: 'chunk', data: { body: btoa('data: first\n\n') } })
      await lastChunk
      channel.onmessage({ event: 'chunk', data: { body: btoa('data: second\n\n') } })
      channel.onmessage({ event: 'finished' })
      return undefined
    })

    const response = await proxyAiFetch('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer key', 'Content-Type': 'application/json' },
      body: '{"model":"test","stream":true}',
    })
    const reader = response.body!.getReader()

    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
    releaseLastChunk()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('data: second\n\n')
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    expect(response.status).toBe(200)
    expect(invoke).toHaveBeenCalledWith('proxy_ai_request', {
      input: {
        url: 'https://example.com/v1/chat/completions',
        method: 'POST',
        headers: {
          authorization: 'Bearer key',
          'content-type': 'application/json',
        },
        body: '{"model":"test","stream":true}',
      },
      onEvent: expect.anything(),
    })
  })

  it('propagates proxy failures before response headers arrive', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('proxy failed'))

    await expect(proxyAiFetch('https://example.com/v1/models')).rejects.toThrow('proxy failed')
  })
})
