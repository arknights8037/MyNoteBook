export type AiReasoningEffort = 'auto' | 'low' | 'medium' | 'high'
export type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'openai-compatible'

export interface AiProviderProfile {
  endpoint: string
  apiKey: string
  model: string
  availableModels: string[]
  reasoningEffort: AiReasoningEffort
  temperature: number
  topP: number
  maxTokens: number
}

export interface AiSettings extends AiProviderProfile {
  provider: AiProvider
  providerProfiles: Record<AiProvider, AiProviderProfile>
  systemPrompt: string
}

export interface AiRunInput {
  prompt: string
  context: string
  settings: AiSettings
  onDelta: (delta: string, channel?: 'content' | 'reasoning') => void
  signal?: AbortSignal
  systemPrompt?: string
  outputMode?: 'markdown' | 'agent-json'
}

export interface AiProviderConfig {
  value: AiProvider
  label: string
  description: string
  endpoint: string
  models: string[]
}

const AI_SETTINGS_STORAGE_KEY = 'my-notebook:ai-settings'

export const AI_PROVIDER_CONFIGS: AiProviderConfig[] = [
  { value: 'openai', label: 'OpenAI', description: 'Chat Completions', endpoint: 'https://api.openai.com/v1', models: [] },
  { value: 'anthropic', label: 'Anthropic', description: 'Claude Messages', endpoint: 'https://api.anthropic.com/v1', models: [] },
  { value: 'deepseek', label: 'DeepSeek', description: 'OpenAI-compatible', endpoint: 'https://api.deepseek.com', models: [] },
  { value: 'qwen', label: '通义千问', description: 'DashScope 兼容模式', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [] },
  { value: 'openai-compatible', label: '兼容接口', description: '自定义 OpenAI-compatible', endpoint: 'https://api.openai.com/v1', models: [] },
]

const DEFAULT_SYSTEM_PROMPT =
  '你是一个文档笔记助手。请输出结构清晰的 Markdown，优先使用标题、列表、表格、代码块和数学公式。'

function createDefaultProfile(provider: AiProvider): AiProviderProfile {
  return {
    endpoint: getAiProviderConfig(provider).endpoint,
    apiKey: '',
    model: '',
    availableModels: [],
    reasoningEffort: 'auto',
    temperature: 0.4,
    topP: 1,
    maxTokens: 2048,
  }
}

function createDefaultProfiles(): Record<AiProvider, AiProviderProfile> {
  return {
    openai: createDefaultProfile('openai'),
    anthropic: createDefaultProfile('anthropic'),
    deepseek: createDefaultProfile('deepseek'),
    qwen: createDefaultProfile('qwen'),
    'openai-compatible': createDefaultProfile('openai-compatible'),
  }
}

export const DEFAULT_AI_SETTINGS: AiSettings = createAiSettings('openai')

export function createAiSettings(provider: AiProvider): AiSettings {
  const providerProfiles = createDefaultProfiles()
  return {
    provider,
    providerProfiles,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    ...providerProfiles[provider],
  }
}

export function getAiProviderConfig(provider: AiProvider): AiProviderConfig {
  return AI_PROVIDER_CONFIGS.find((option) => option.value === provider) ?? AI_PROVIDER_CONFIGS[0]
}

export function updateActiveAiProfile(
  settings: AiSettings,
  patch: Partial<AiProviderProfile>,
): AiSettings {
  const profile = normalizeProfile({ ...settings, ...patch }, settings.provider)
  return {
    ...settings,
    ...profile,
    providerProfiles: { ...settings.providerProfiles, [settings.provider]: profile },
  }
}

export function applyAiProviderDefaults(settings: AiSettings, provider: AiProvider): AiSettings {
  const committed = updateActiveAiProfile(settings, {})
  const profile = committed.providerProfiles[provider] ?? createDefaultProfile(provider)
  return { ...committed, provider, ...profile }
}

export function loadAiSettings(): AiSettings {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(AI_SETTINGS_STORAGE_KEY) ?? '{}') as Partial<AiSettings>
    return normalizeAiSettings(parsed)
  } catch {
    return createAiSettings('openai')
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    const persisted = updateActiveAiProfile(normalizeAiSettings(settings), {})
    persisted.apiKey = ''
    persisted.providerProfiles = Object.fromEntries(
      Object.entries(persisted.providerProfiles).map(([provider, profile]) => [
        provider,
        { ...profile, apiKey: '' },
      ]),
    ) as Record<AiProvider, AiProviderProfile>
    globalThis.localStorage?.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Settings remain active for the current session when storage is unavailable.
  }
}

export function normalizeAiSettings(settings: Partial<AiSettings>): AiSettings {
  const provider = isAiProvider(settings.provider) ? settings.provider : 'openai'
  const rawProfiles = isRecord(settings.providerProfiles) ? settings.providerProfiles : null
  const providerProfiles = createDefaultProfiles()

  for (const config of AI_PROVIDER_CONFIGS) {
    const storedProfile = rawProfiles?.[config.value]
    if (isRecord(storedProfile)) {
      providerProfiles[config.value] = normalizeProfile(storedProfile, config.value)
    }
  }

  // Legacy settings had one flat profile. Migrate it to the provider selected at upgrade time.
  const hasLegacyProfile = !rawProfiles && hasFlatProfileFields(settings)
  if (hasLegacyProfile) {
    providerProfiles[provider] = normalizeProfile(settings, provider)
  } else if (rawProfiles) {
    providerProfiles[provider] = normalizeProfile(
      { ...providerProfiles[provider], ...pickFlatProfile(settings) },
      provider,
    )
  }

  return {
    provider,
    providerProfiles,
    systemPrompt:
      typeof settings.systemPrompt === 'string' && settings.systemPrompt.trim()
        ? settings.systemPrompt.trim()
        : DEFAULT_SYSTEM_PROMPT,
    ...providerProfiles[provider],
  }
}

function normalizeProfile(settings: Partial<AiProviderProfile>, provider: AiProvider): AiProviderProfile {
  const defaults = createDefaultProfile(provider)
  return {
    endpoint: normalizeEndpoint(settings.endpoint, defaults.endpoint),
    apiKey: typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '',
    model: typeof settings.model === 'string' ? settings.model.trim() : '',
    availableModels: normalizeModelList(settings.availableModels),
    reasoningEffort: isReasoningEffort(settings.reasoningEffort) ? settings.reasoningEffort : 'auto',
    temperature: clampNumber(settings.temperature, 0, 2, defaults.temperature),
    topP: clampNumber(settings.topP, 0, 1, defaults.topP),
    maxTokens: Math.round(clampNumber(settings.maxTokens, 1, 128000, defaults.maxTokens)),
  }
}

function pickFlatProfile(settings: Partial<AiSettings>): Partial<AiProviderProfile> {
  return {
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
    model: settings.model,
    availableModels: settings.availableModels,
    reasoningEffort: settings.reasoningEffort,
    temperature: settings.temperature,
    topP: settings.topP,
    maxTokens: settings.maxTokens,
  }
}

function hasFlatProfileFields(settings: Partial<AiSettings>): boolean {
  return Object.values(pickFlatProfile(settings)).some((value) => value !== undefined)
}

function normalizeModelList(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  return Array.from(new Set(models.map((model) => (typeof model === 'string' ? model.trim() : '')).filter(Boolean))).slice(0, 200)
}

function normalizeEndpoint(endpoint: unknown, fallback: string): string {
  const value = typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : fallback
  return value.replace(/\/+$/, '')
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(value, max)) : fallback
}

function isReasoningEffort(value: unknown): value is AiReasoningEffort {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high'
}

function isAiProvider(value: unknown): value is AiProvider {
  return AI_PROVIDER_CONFIGS.some((config) => config.value === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
