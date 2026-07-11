import { ref, type Ref } from 'vue'

import { updateActiveAiProfile, type AiProvider, type AiSettings } from '@/models/ai'
import { loadAiApiKey, saveAiApiKey } from '@/services/AiSecretService'

export type AiSecretStatus = 'idle' | 'loading' | 'loaded' | 'failed'

export function useAiSecret(
  settings: Ref<AiSettings>,
  onError: (message: string) => void,
) {
  const status = ref<AiSecretStatus>('idle')
  const loadedProviders = new Set<AiProvider>()
  const loadPromises = new Map<AiProvider, Promise<boolean>>()

  function markUserProvidedApiKey(): void {
    loadedProviders.add(settings.value.provider)
    status.value = 'loaded'
  }

  function ensureLoaded(timeoutMs = 3000): Promise<boolean> {
    const provider = settings.value.provider
    if (loadedProviders.has(provider)) return Promise.resolve(true)
    let loadPromise = loadPromises.get(provider)
    if (!loadPromise) {
      status.value = 'loading'
      loadPromise = hydrate(provider)
      loadPromises.set(provider, loadPromise)
    }
    return Promise.race([
      loadPromise,
      new Promise<boolean>((resolve) => globalThis.setTimeout(() => resolve(false), timeoutMs)),
    ])
  }

  async function hydrate(provider: AiProvider): Promise<boolean> {
    try {
      const legacyApiKey = settings.value.providerProfiles[provider]?.apiKey.trim() ?? ''
      const storedApiKey = await loadAiApiKey(provider)
      const apiKey = storedApiKey || legacyApiKey
      if (!storedApiKey && legacyApiKey) await saveAiApiKey(provider, legacyApiKey)
      if (settings.value.provider === provider) {
        settings.value = updateActiveAiProfile(settings.value, { apiKey })
      } else {
        settings.value = {
          ...settings.value,
          providerProfiles: {
            ...settings.value.providerProfiles,
            [provider]: { ...settings.value.providerProfiles[provider], apiKey },
          },
        }
      }
      loadedProviders.add(provider)
      status.value = 'loaded'
      return true
    } catch {
      status.value = 'failed'
      loadPromises.delete(provider)
      return false
    }
  }

  async function persist(provider: AiProvider, apiKey: string): Promise<void> {
    if (!loadedProviders.has(provider)) return
    try {
      await saveAiApiKey(provider, apiKey)
    } catch {
      onError('无法写入系统密钥库，API Key 仅在本次会话可用。')
    }
  }

  return { status, ensureLoaded, markUserProvidedApiKey, persist }
}
