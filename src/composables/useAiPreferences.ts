import { computed, ref, watch, type Ref } from 'vue'

import { useAiSecret } from './useAiSecret'
import {
  AI_PROVIDER_CONFIGS,
  DEFAULT_AI_SETTINGS,
  applyAiProviderDefaults,
  createAiSettings,
  loadAiSettings,
  saveAiSettings,
  updateActiveAiProfile,
  type AiProvider,
  type AiReasoningEffort,
} from '@/models/ai'
import { AI_MODE_OPTIONS, type AiChatMode, type AiSelectorOption } from '@/models/aiChatMode'

const AI_REASONING_OPTIONS: Array<AiSelectorOption<AiReasoningEffort>> = [
  { value: 'auto', label: '自动', description: '按模型默认策略' },
  { value: 'low', label: '轻量思考', description: '更快响应' },
  { value: 'medium', label: '标准思考', description: '平衡质量与速度' },
  { value: 'high', label: '深度思考', description: '更适合复杂整理' },
]

export function useAiPreferences(error: Ref<string>) {
  const aiSettings = ref(loadAiSettings())
  const aiChatMode = ref<AiChatMode>('agent')
  const aiSecret = useAiSecret(aiSettings, (message) => {
    error.value = message
  })

  const aiModeLabel = computed(() => getOptionLabel(AI_MODE_OPTIONS, aiChatMode.value))
  const aiProviderLabel = computed(() =>
    getOptionLabel(AI_PROVIDER_CONFIGS, aiSettings.value.provider),
  )
  const aiReasoningLabel = computed(() =>
    getOptionLabel(AI_REASONING_OPTIONS, aiSettings.value.reasoningEffort),
  )
  const aiPromptPlaceholder = computed(() =>
    aiChatMode.value === 'edit'
      ? '告诉 AI 要怎么改写当前文档'
      : aiChatMode.value === 'agent'
        ? '交给 Agent 一个需要检索、整理或改写的任务'
        : aiChatMode.value === 'auto'
          ? '描述你的目标，AI 会自动选择问答、改写或 Agent'
          : '问问当前文档，或让 AI 整理内容',
  )
  const aiModelOptions = computed(() =>
    Array.from(
      new Set([aiSettings.value.model, ...aiSettings.value.availableModels].filter(Boolean)),
    ),
  )

  watch(aiSettings, saveAiSettings, { deep: true })
  watch(
    () => [aiSettings.value.provider, aiSettings.value.apiKey] as const,
    ([provider, apiKey], [previousProvider, previousApiKey]) => {
      if (provider !== previousProvider || apiKey === previousApiKey) return
      void aiSecret.persist(provider, apiKey)
    },
  )

  function updateAiSettings(settings: typeof aiSettings.value): void {
    if (
      settings.provider === aiSettings.value.provider &&
      settings.apiKey !== aiSettings.value.apiKey
    ) {
      aiSecret.markUserProvidedApiKey()
    }
    aiSettings.value = settings
  }

  function selectAiMode(mode: AiChatMode): void {
    aiChatMode.value = mode
  }

  function selectAiProvider(provider: AiProvider): void {
    aiSettings.value = applyAiProviderDefaults(aiSettings.value, provider)
  }

  function selectAiModel(model: string): void {
    aiSettings.value = updateActiveAiProfile(aiSettings.value, { model })
  }

  function selectAiReasoning(reasoningEffort: AiReasoningEffort): void {
    aiSettings.value = updateActiveAiProfile(aiSettings.value, { reasoningEffort })
  }

  function resetAiSettings(): void {
    aiSettings.value = createAiSettings(DEFAULT_AI_SETTINGS.provider)
  }

  return {
    aiSettings,
    aiChatMode,
    aiModeLabel,
    aiProviderLabel,
    aiReasoningLabel,
    aiPromptPlaceholder,
    aiModelOptions,
    reasoningOptions: AI_REASONING_OPTIONS,
    updateAiSettings,
    selectAiMode,
    selectAiProvider,
    selectAiModel,
    selectAiReasoning,
    resetAiSettings,
    ensureAiSecretLoaded: aiSecret.ensureLoaded,
  }
}

function getOptionLabel<T extends string>(options: Array<AiSelectorOption<T>>, value: T): string {
  return options.find((option) => option.value === value)?.label ?? value
}
