import type { AiSettings } from '@/models/ai'
import { resolveProviderCapabilities } from '@/models/providerCapabilities'

export interface LanguageModelUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export function mergeLanguageModelUsage(
  left: LanguageModelUsage,
  right: LanguageModelUsage,
): LanguageModelUsage {
  const add = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
  }
}

export function createLiveReasoningEmitter(emit: (delta: string) => void): {
  push: (delta: string) => void
  hasEmitted: () => boolean
} {
  let decision: 'pending' | 'display' | 'suppress' = 'pending'
  let pending = ''
  let emitted = false
  return {
    push(delta) {
      if (!delta || decision === 'suppress') return
      if (decision === 'display') {
        emitted = true
        emit(delta)
        return
      }
      pending += delta
      const trimmed = pending.trimStart()
      if (!trimmed) return
      if (/^(?:\{|\[|```(?:json)?)/i.test(trimmed)) {
        decision = 'suppress'
        pending = ''
        return
      }
      decision = 'display'
      emitted = true
      emit(pending)
      pending = ''
    },
    hasEmitted: () => emitted,
  }
}

export function projectLanguageModelUsage(usage?: LanguageModelUsage): LanguageModelUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}

export function samplingParameters(settings: AiSettings, temperature = settings.temperature) {
  const capabilities = resolveProviderCapabilities(settings.provider, settings.model)
  return {
    ...(capabilities.temperature ? { temperature } : {}),
    ...(capabilities.topP ? { topP: settings.topP } : {}),
  }
}

export function collectReasoningText(result: {
  reasoningText?: string
  steps: Array<{ reasoningText?: string }>
}): string {
  const stepReasoning = result.steps
    .map((step) => step.reasoningText?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
  return stepReasoning || result.reasoningText?.trim() || ''
}
