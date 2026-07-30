import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { loadAiSettings, type AiSettings } from '@/models/ai/ai'

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
    await configureAgentBackgroundRuntime(dataDirectory, loadAiSettings())
    await invoke<void>('start_agent_request_watcher', {
      input: { dataDirectory },
    })
  } catch (error) {
    unlisten()
    throw error
  }
  return unlisten
}

export function listenAgentRequestQueue(
  listener: (snapshot: AgentRequestQueueSnapshot) => void,
): Promise<() => void> {
  return listen<AgentRequestQueueSnapshot>(QUEUE_EVENT, ({ payload }) => listener(payload))
}

export async function configureAgentBackgroundRuntime(
  dataDirectory: string | undefined,
  settings: AiSettings,
): Promise<void> {
  if (!settings.model.trim()) return
  await invoke<void>('configure_agent_background_runtime', {
    input: {
      dataDirectory,
      profile: {
        modelPolicy: {
          provider: settings.provider,
          model: settings.model,
          endpoint: settings.endpoint,
          temperature: settings.temperature,
          topP: settings.topP,
          reasoningEffort: settings.reasoningEffort,
          maxOutputTokens: settings.maxTokens,
          credentialRef: { kind: 'provider_secret', provider: settings.provider },
        },
        configuredMaxTokens: settings.maxTokens,
        systemInstructions: settings.systemPrompt,
      },
    },
  })
}
