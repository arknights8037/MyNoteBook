import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_AI_SETTINGS,
  applyAiProviderDefaults,
  loadAiSettings,
  normalizeAiSettings,
  saveAiSettings,
} from './ai'

describe('AI settings', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('persists reasoning effort with the rest of the AI settings', () => {
    const settings = {
      ...DEFAULT_AI_SETTINGS,
      model: 'gpt-5-mini',
      reasoningEffort: 'high' as const,
    }

    saveAiSettings(settings)

    expect(loadAiSettings()).toEqual(settings)
  })

  it('normalizes invalid reasoning effort values', () => {
    expect(normalizeAiSettings({ reasoningEffort: 'maximum' as never }).reasoningEffort).toBe(
      DEFAULT_AI_SETTINGS.reasoningEffort,
    )
  })

  it('applies provider endpoint and model defaults from the shared provider registry', () => {
    expect(applyAiProviderDefaults(DEFAULT_AI_SETTINGS, 'anthropic')).toMatchObject({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
    })
  })

  it('keeps custom endpoint and model values for OpenAI-compatible providers', () => {
    const settings = {
      ...DEFAULT_AI_SETTINGS,
      endpoint: 'http://localhost:11434/v1',
      model: 'local-model',
    }

    expect(applyAiProviderDefaults(settings, 'openai-compatible')).toMatchObject({
      provider: 'openai-compatible',
      endpoint: settings.endpoint,
      model: settings.model,
    })
  })
})
