import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_AI_SETTINGS, loadAiSettings, normalizeAiSettings, saveAiSettings } from './ai'

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
})
