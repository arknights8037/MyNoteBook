import { invoke } from '@tauri-apps/api/core'

import type { AiSettings } from '@/models/ai'
import { loadAiApiKey } from '@/services/AiSecretService'

interface ModelsResponse {
  data?: Array<{ id?: string; name?: string; display_name?: string }>
  models?: Array<string | { id?: string; name?: string; display_name?: string }>
}

export async function fetchAiModelOptions(settings: AiSettings): Promise<string[]> {
  const apiKey = await resolveModelListApiKey(settings)
  const payload = await invoke<ModelsResponse>('fetch_ai_models', {
    input: {
      endpoint: settings.endpoint,
      provider: settings.provider,
      apiKey,
    },
  })
  const models = [
    ...(payload.data ?? []).map(readModelId),
    ...(payload.models ?? []).map(readModelId),
  ].filter(Boolean)

  const uniqueModels = Array.from(new Set(models))
  if (uniqueModels.length === 0) {
    throw new Error('目标端点没有返回可识别的模型列表。')
  }

  return uniqueModels.sort((a, b) => a.localeCompare(b))
}

async function resolveModelListApiKey(settings: AiSettings): Promise<string> {
  const configuredApiKey = settings.apiKey.trim()
  if (configuredApiKey) return configuredApiKey

  try {
    return (await loadAiApiKey(settings.provider)).trim()
  } catch {
    // Public model endpoints can still be queried when the local secret store is unavailable.
    return ''
  }
}

function readModelId(
  model: string | { id?: string; name?: string; display_name?: string },
): string {
  if (typeof model === 'string') return model.trim()
  return (model.id ?? model.name ?? model.display_name ?? '').trim()
}
