import { invoke } from '@tauri-apps/api/core'

import type { AiProvider } from '@/models/ai'

const cachedApiKeys = new Map<AiProvider, string>()

export async function loadAiApiKey(provider: AiProvider): Promise<string> {
  const cached = cachedApiKeys.get(provider)
  if (cached !== undefined) return cached
  const apiKey = await invoke<string>('get_ai_api_key', { provider })
  cachedApiKeys.set(provider, apiKey)
  return apiKey
}

export async function saveAiApiKey(provider: AiProvider, apiKey: string): Promise<void> {
  const normalized = apiKey.trim()
  await invoke('set_ai_api_key', { provider, apiKey: normalized })
  cachedApiKeys.set(provider, normalized)
}

export async function migrateLegacyAiApiKey(provider: AiProvider, apiKey: string): Promise<string> {
  const existing = await loadAiApiKey(provider)
  if (existing) return existing
  if (apiKey.trim()) await saveAiApiKey(provider, apiKey)
  return apiKey.trim()
}

export function resetAiSecretCacheForTests(): void {
  cachedApiKeys.clear()
}
