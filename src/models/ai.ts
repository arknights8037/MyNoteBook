export type AiReasoningEffort = 'auto' | 'low' | 'medium' | 'high'
export type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'openai-compatible'

export interface AiSettings {
  provider: AiProvider
  endpoint: string
  apiKey: string
  model: string
  reasoningEffort: AiReasoningEffort
  systemPrompt: string
  temperature: number
  topP: number
  maxTokens: number
}

export interface AiRunInput {
  prompt: string
  context: string
  settings: AiSettings
  onDelta: (delta: string) => void
  signal?: AbortSignal
}

const AI_SETTINGS_STORAGE_KEY = 'my-notebook:ai-settings'

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4.1-mini',
  reasoningEffort: 'auto',
  systemPrompt:
    '你是一个文档笔记助手。请输出结构清晰的 Markdown，优先使用标题、列表、表格、代码块和数学公式。',
  temperature: 0.4,
  topP: 1,
  maxTokens: 2048,
}

export function loadAiSettings(): AiSettings {
  try {
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem(AI_SETTINGS_STORAGE_KEY) ?? '{}',
    ) as Partial<AiSettings>
    return normalizeAiSettings(parsed)
  } catch {
    return { ...DEFAULT_AI_SETTINGS }
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    globalThis.localStorage?.setItem(
      AI_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizeAiSettings(settings)),
    )
  } catch {
    // Settings remain active for the current session when storage is unavailable.
  }
}

export function normalizeAiSettings(settings: Partial<AiSettings>): AiSettings {
  return {
    provider: isAiProvider(settings.provider) ? settings.provider : DEFAULT_AI_SETTINGS.provider,
    endpoint: normalizeEndpoint(settings.endpoint),
    apiKey: typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '',
    model:
      typeof settings.model === 'string' && settings.model.trim()
        ? settings.model.trim()
        : DEFAULT_AI_SETTINGS.model,
    reasoningEffort: isReasoningEffort(settings.reasoningEffort)
      ? settings.reasoningEffort
      : DEFAULT_AI_SETTINGS.reasoningEffort,
    systemPrompt:
      typeof settings.systemPrompt === 'string' && settings.systemPrompt.trim()
        ? settings.systemPrompt.trim()
        : DEFAULT_AI_SETTINGS.systemPrompt,
    temperature:
      typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)
        ? Math.max(0, Math.min(settings.temperature, 2))
        : DEFAULT_AI_SETTINGS.temperature,
    topP:
      typeof settings.topP === 'number' && Number.isFinite(settings.topP)
        ? Math.max(0, Math.min(settings.topP, 1))
        : DEFAULT_AI_SETTINGS.topP,
    maxTokens:
      typeof settings.maxTokens === 'number' && Number.isFinite(settings.maxTokens)
        ? Math.max(1, Math.min(Math.round(settings.maxTokens), 128000))
        : DEFAULT_AI_SETTINGS.maxTokens,
  }
}

function normalizeEndpoint(endpoint: unknown): string {
  const value =
    typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : DEFAULT_AI_SETTINGS.endpoint
  return value.replace(/\/+$/, '')
}

function isReasoningEffort(value: unknown): value is AiReasoningEffort {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high'
}

function isAiProvider(value: unknown): value is AiProvider {
  return (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'deepseek' ||
    value === 'qwen' ||
    value === 'openai-compatible'
  )
}
