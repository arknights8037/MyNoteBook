import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_AI_SETTINGS,
  applyAiProviderDefaults,
  createAiSettings,
  loadAiSettings,
  normalizeAiSettings,
  saveAiSettings,
} from '@/models/ai/ai'

describe('AI settings', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('persists reasoning effort with the rest of the AI settings', () => {
    const settings = {
      ...DEFAULT_AI_SETTINGS,
      model: 'gpt-5-mini',
      availableModels: ['gpt-5-mini', 'gpt-5'],
      reasoningEffort: 'high' as const,
    }

    saveAiSettings(settings)

    expect(loadAiSettings()).toMatchObject({
      provider: 'openai',
      apiKey: '',
      model: 'gpt-5-mini',
      availableModels: ['gpt-5-mini', 'gpt-5'],
      reasoningEffort: 'high',
      providerProfiles: {
        openai: {
          apiKey: '',
          model: 'gpt-5-mini',
          availableModels: ['gpt-5-mini', 'gpt-5'],
          reasoningEffort: 'high',
        },
      },
    })
  })

  it('never writes an API key to localStorage', () => {
    const settings = createAiSettings('openai')
    settings.apiKey = 'openai-secret'
    settings.providerProfiles.openai.apiKey = 'openai-secret'
    settings.providerProfiles.anthropic.apiKey = 'anthropic-secret'
    saveAiSettings(settings)

    const stored = globalThis.localStorage.getItem('my-notebook:ai-settings') ?? ''
    expect(stored).not.toContain('openai-secret')
    expect(stored).not.toContain('anthropic-secret')
  })

  it('normalizes invalid reasoning effort values', () => {
    expect(normalizeAiSettings({ reasoningEffort: 'maximum' as never }).reasoningEffort).toBe(
      DEFAULT_AI_SETTINGS.reasoningEffort,
    )
    expect(normalizeAiSettings({ availableModels: [' a ', '', 'a', 3] as never })).toMatchObject({
      availableModels: ['a'],
    })
  })

  it('applies provider endpoint without built-in model presets', () => {
    expect(applyAiProviderDefaults(DEFAULT_AI_SETTINGS, 'anthropic')).toMatchObject({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      model: '',
      availableModels: [],
    })
  })

  it('keeps each provider endpoint and model independent', () => {
    const settings = createAiSettings('openai-compatible')
    settings.endpoint = 'http://localhost:11434/v1'
    settings.model = 'local-model'
    const openAi = applyAiProviderDefaults(settings, 'openai')
    const restored = applyAiProviderDefaults(openAi, 'openai-compatible')

    expect(openAi).toMatchObject({
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      model: '',
    })
    expect(restored).toMatchObject({
      provider: 'openai-compatible',
      endpoint: 'http://localhost:11434/v1',
      model: 'local-model',
    })
  })

  it('restores the target provider fetched models when switching', () => {
    const settings = createAiSettings('openai')
    settings.availableModels = ['gpt']
    settings.providerProfiles.deepseek.availableModels = ['deepseek-chat']
    expect(applyAiProviderDefaults(settings, 'deepseek')).toMatchObject({
      provider: 'deepseek',
      availableModels: ['deepseek-chat'],
    })
  })

  it('migrates legacy flat settings into the selected provider profile', () => {
    const migrated = normalizeAiSettings({
      provider: 'anthropic',
      endpoint: 'https://proxy.example/v1',
      model: 'claude-custom',
      reasoningEffort: 'high',
    } as never)

    expect(migrated.providerProfiles.anthropic).toMatchObject({
      endpoint: 'https://proxy.example/v1',
      model: 'claude-custom',
      reasoningEffort: 'high',
    })
    expect(migrated.providerProfiles.openai.model).toBe('')
  })
})
