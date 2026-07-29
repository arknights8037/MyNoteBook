import { createInterface } from 'node:readline'

import type {
  PiToolRpcInvocation,
  PiToolRpcPort,
  PiToolRpcProgress,
  PiToolRpcResult,
} from './types.js'

export type PiToolRpcOutboundMessage =
  | { version: 1; type: 'tool.invoke'; request: PiToolRpcInvocation }
  | {
      version: 1
      type: 'tool.cancel'
      requestId: string
      runId: string
      internalToolCallId: string
    }

export type PiToolRpcInboundMessage =
  | { version: 1; type: 'tool.progress'; requestId: string; progress: PiToolRpcProgress }
  | { version: 1; type: 'tool.result'; requestId: string; result: PiToolRpcResult }

export interface PiToolRpcChannel {
  send(message: PiToolRpcOutboundMessage): void
  subscribe(listener: (message: PiToolRpcInboundMessage) => void): () => void
}

interface PendingInvocation {
  request: PiToolRpcInvocation
  onProgress: (progress: PiToolRpcProgress) => void
  resolve: (result: PiToolRpcResult) => void
  reject: (error: Error) => void
  abortCleanup: () => void
  cancelSent: boolean
}

/**
 * Minimal Phase 2 Node -> Rust tool RPC adapter. Aborting sends tool.cancel but
 * deliberately waits for Rust's terminal tool.result so audit state settles
 * before cancelRun resolves.
 */
export class StdioPiToolRpcClient implements PiToolRpcPort {
  private readonly pending = new Map<string, PendingInvocation>()
  private readonly unsubscribe: () => void

  constructor(private readonly channel: PiToolRpcChannel) {
    this.unsubscribe = channel.subscribe((message) => this.onMessage(message))
  }

  invoke(
    request: PiToolRpcInvocation,
    options: {
      signal?: AbortSignal
      onProgress: (progress: PiToolRpcProgress) => void
    },
  ): Promise<PiToolRpcResult> {
    if (this.pending.has(request.requestId)) {
      return Promise.reject(new Error(`duplicate RPC requestId ${request.requestId}`))
    }
    if (options.signal?.aborted) return Promise.reject(abortError())

    return new Promise<PiToolRpcResult>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(request.requestId)
        if (!pending || pending.cancelSent) return
        pending.cancelSent = true
        this.channel.send({
          version: 1,
          type: 'tool.cancel',
          requestId: request.requestId,
          runId: request.runId,
          internalToolCallId: request.internalToolCallId,
        })
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.requestId, {
        request,
        onProgress: options.onProgress,
        resolve,
        reject,
        abortCleanup: () => options.signal?.removeEventListener('abort', onAbort),
        cancelSent: false,
      })
      this.channel.send({ version: 1, type: 'tool.invoke', request })
    })
  }

  dispose(reason = 'PI tool RPC channel closed.'): void {
    this.unsubscribe()
    for (const pending of this.pending.values()) {
      pending.abortCleanup()
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private onMessage(message: PiToolRpcInboundMessage): void {
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    if (message.type === 'tool.progress') {
      pending.onProgress(message.progress)
      return
    }
    pending.abortCleanup()
    this.pending.delete(message.requestId)
    pending.resolve(message.result)
  }
}

export function createNodeStdioToolRpcChannel(): PiToolRpcChannel {
  const listeners = new Set<(message: PiToolRpcInboundMessage) => void>()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as PiToolRpcInboundMessage
      if (message.version !== 1 || !['tool.progress', 'tool.result'].includes(message.type)) return
      for (const listener of listeners) listener(message)
    } catch {
      // Invalid host input is ignored; stdout remains a protocol-only channel.
    }
  })
  return {
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function abortError(): Error {
  const error = new Error('PI tool RPC aborted before invocation.')
  error.name = 'AbortError'
  return error
}
