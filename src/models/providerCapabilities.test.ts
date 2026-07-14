import { describe, expect, it } from 'vitest'
import { createAiSettings } from './ai'
import { auditConfiguredModelParameters, resolveProviderCapabilities } from './providerCapabilities'

describe('Provider Capability Matrix', () => {
  it('disables sampling and enables reasoning for OpenAI reasoning models', () => {
    const capabilities = resolveProviderCapabilities('openai', 'gpt-5-mini')
    expect(capabilities).toMatchObject({ temperature: false, topP: false, reasoningEffort: true, structuredOutput: true })
  })

  it('records requested, actual and ignored parameters separately', () => {
    const settings = { ...createAiSettings('openai'), model: 'gpt-5', reasoningEffort: 'high' as const }
    const audit = auditConfiguredModelParameters(settings)
    expect(audit.requested).toHaveProperty('temperature')
    expect(audit.actual).toMatchObject({ reasoningEffort: 'high', streaming: true })
    expect(audit.ignored).toEqual(expect.arrayContaining(['temperature', 'topP']))
  })

  it('is conservative for unknown OpenAI-compatible endpoints', () => {
    expect(resolveProviderCapabilities('openai-compatible', 'custom').toolChoice).toBe(false)
  })
})
