import { createInterface } from 'node:readline'

import type {
  AgentWorkerHostMessage,
  AgentWorkerMessage,
} from '@mynotebook/agent-runtime-contracts'

import type { AgentWorkerChannel } from './AgentWorkerHost.js'

/** stdout is protocol-only; diagnostics must be written to stderr. */
export function createStdioAgentWorkerChannel(): AgentWorkerChannel {
  const listeners = new Set<(message: AgentWorkerHostMessage) => void>()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as AgentWorkerHostMessage
      if (message.version !== 1 || typeof message.type !== 'string') return
      for (const listener of listeners) listener(message)
    } catch (error) {
      process.stderr.write(
        `[agent-worker] ignored invalid host message: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  })
  return {
    send(message: AgentWorkerMessage) {
      process.stdout.write(`${JSON.stringify(message)}\n`)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      lines.close()
    },
  }
}
