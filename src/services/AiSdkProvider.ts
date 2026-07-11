import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

import type { AiSettings } from '@/models/ai'

export function createAiSdkModel(settings: AiSettings): LanguageModel {
  const baseURL = settings.endpoint.replace(/\/+$/, '')
  if (settings.provider === 'anthropic') {
    return createAnthropic({
      apiKey: settings.apiKey,
      baseURL,
      name: 'mynotebook-anthropic',
    })(settings.model)
  }

  const provider = createOpenAICompatible({
    name: `mynotebook-${settings.provider}`,
    apiKey: settings.apiKey,
    baseURL,
    includeUsage: true,
  })
  return provider(settings.model)
}
