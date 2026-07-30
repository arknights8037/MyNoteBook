import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const QUEUE_EVENT = 'agent-communication://queue-changed'

export interface AgentRequestQueueSnapshot {
  actionableCount: number
  latestUpdateAt: number | null
  occurredAt: number
}

export async function subscribeAgentRequestQueue(
  dataDirectory: string | undefined,
  listener: (snapshot: AgentRequestQueueSnapshot) => void,
): Promise<() => void> {
  const unlisten = await listen<AgentRequestQueueSnapshot>(QUEUE_EVENT, ({ payload }) =>
    listener(payload),
  )
  try {
    await invoke<void>('start_agent_request_watcher', {
      input: { dataDirectory },
    })
  } catch (error) {
    unlisten()
    throw error
  }
  return unlisten
}
