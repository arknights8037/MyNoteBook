import type { AiProvider, AiSettings } from './ai'

export interface ProviderModelCapabilities {
  temperature: boolean
  topP: boolean
  reasoningEffort: boolean
  reasoningContent: boolean
  toolChoice: boolean
  structuredOutput: boolean
  systemMessage: boolean
  developerMessage: boolean
  streaming: boolean
  maxContextTokens: number | null
  maxOutputTokens: number | null
}

const BASE: ProviderModelCapabilities = {
  temperature: true, topP: true, reasoningEffort: false, reasoningContent: false,
  toolChoice: true, structuredOutput: false, systemMessage: true, developerMessage: false,
  streaming: true, maxContextTokens: null, maxOutputTokens: null,
}

export function resolveProviderCapabilities(provider: AiProvider, model: string): ProviderModelCapabilities {
  const normalized = model.trim().toLowerCase()
  if (provider === 'openai') {
    const reasoning = /^(o\d|o-|gpt-5)/.test(normalized)
    return { ...BASE, temperature: !reasoning, topP: !reasoning, reasoningEffort: reasoning,
      structuredOutput: true, developerMessage: true,
      maxContextTokens: normalized.startsWith('gpt-5') ? 400_000 : null,
      maxOutputTokens: normalized.startsWith('gpt-5') ? 128_000 : null }
  }
  if (provider === 'anthropic') return { ...BASE, reasoningEffort: true, reasoningContent: true, maxContextTokens: 200_000 }
  if (provider === 'deepseek') {
    const reasoning = normalized.includes('reasoner') || normalized.includes('r1')
    return { ...BASE, reasoningEffort: reasoning, reasoningContent: reasoning, toolChoice: !reasoning, maxContextTokens: 128_000 }
  }
  if (provider === 'qwen') return { ...BASE, reasoningEffort: true, reasoningContent: true, structuredOutput: true }
  return { ...BASE, toolChoice: false }
}

export function auditConfiguredModelParameters(settings: AiSettings) {
  const capabilities = resolveProviderCapabilities(settings.provider, settings.model)
  const requested: Record<string, unknown> = { temperature: settings.temperature, topP: settings.topP,
    reasoningEffort: settings.reasoningEffort, maxOutputTokens: settings.maxTokens, streaming: true }
  const actual: Record<string, unknown> = { maxOutputTokens: settings.maxTokens, streaming: true }
  const ignored: string[] = []
  if (capabilities.temperature) actual.temperature = settings.temperature
  else ignored.push('temperature')
  if (capabilities.topP) actual.topP = settings.topP
  else ignored.push('topP')
  if (settings.reasoningEffort !== 'auto') {
    if (capabilities.reasoningEffort) actual.reasoningEffort = settings.reasoningEffort
    else ignored.push('reasoningEffort')
  }
  return { requested, actual, ignored }
}
