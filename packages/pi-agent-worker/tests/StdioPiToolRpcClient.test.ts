import { describe, expect, it, vi } from 'vitest'

import {
  StdioPiToolRpcClient,
  type PiToolRpcChannel,
  type PiToolRpcInboundMessage,
  type PiToolRpcOutboundMessage,
} from '../src/StdioPiToolRpcClient.js'
import type { PiToolRpcInvocation } from '../src/types.js'

describe('StdioPiToolRpcClient', () => {
  it('multiplexes parallel progress/results and preserves MCP isError', async () => {
    const channel = createChannel()
    const client = new StdioPiToolRpcClient(channel)
    const progress = vi.fn()
    const first = client.invoke(invocation('rpc-1', 'internal-1', 'provider-1'), {
      onProgress: progress,
    })
    const second = client.invoke(invocation('rpc-2', 'internal-2', 'provider-2'), {
      onProgress: progress,
    })

    channel.receive({
      version: 1,
      type: 'tool.progress',
      requestId: 'rpc-2',
      progress: { message: 'halfway', value: { percent: 50 } },
    })
    channel.receive({
      version: 1,
      type: 'tool.result',
      requestId: 'rpc-2',
      result: { ok: true, isError: true, error: 'MCP business error' },
    })
    channel.receive({
      version: 1,
      type: 'tool.result',
      requestId: 'rpc-1',
      result: { ok: true, value: { documents: [] } },
    })

    await expect(first).resolves.toMatchObject({ ok: true, value: { documents: [] } })
    await expect(second).resolves.toMatchObject({ isError: true, error: 'MCP business error' })
    expect(progress).toHaveBeenCalledWith({ message: 'halfway', value: { percent: 50 } })
    expect(channel.sent.filter((message) => message.type === 'tool.invoke')).toHaveLength(2)
    client.dispose()
  })

  it('sends cancel and waits for Rust terminal result', async () => {
    const channel = createChannel()
    const client = new StdioPiToolRpcClient(channel)
    const controller = new AbortController()
    let settled = false
    const result = client
      .invoke(invocation('rpc-cancel', 'internal-cancel', 'provider-cancel'), {
        signal: controller.signal,
        onProgress: vi.fn(),
      })
      .finally(() => {
        settled = true
      })

    controller.abort()
    await Promise.resolve()
    expect(channel.sent.at(-1)).toMatchObject({
      type: 'tool.cancel',
      requestId: 'rpc-cancel',
      internalToolCallId: 'internal-cancel',
    })
    expect(settled).toBe(false)

    channel.receive({
      version: 1,
      type: 'tool.result',
      requestId: 'rpc-cancel',
      result: { ok: false, errorCode: 'cancelled', error: 'cancelled by Rust' },
    })
    await expect(result).resolves.toMatchObject({ errorCode: 'cancelled' })
    expect(settled).toBe(true)
    client.dispose()
  })
})

function invocation(
  requestId: string,
  internalToolCallId: string,
  providerToolCallId: string,
): PiToolRpcInvocation {
  return {
    requestId,
    runId: 'run-pi',
    turnId: 'turn-pi',
    internalToolCallId,
    providerToolCallId,
    toolName: 'mcp__trusted__lookup',
    arguments: { query: 'PI' },
    source: {
      kind: 'mcp',
      serverId: 'trusted',
      serverName: 'Trusted',
      toolName: 'lookup',
      readOnly: true,
      serverTrusted: true,
    },
  }
}

function createChannel(): PiToolRpcChannel & {
  sent: PiToolRpcOutboundMessage[]
  receive: (message: PiToolRpcInboundMessage) => void
} {
  const listeners = new Set<(message: PiToolRpcInboundMessage) => void>()
  const sent: PiToolRpcOutboundMessage[] = []
  return {
    sent,
    send: (message) => sent.push(message),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    receive: (message) => {
      for (const listener of listeners) listener(message)
    },
  }
}
