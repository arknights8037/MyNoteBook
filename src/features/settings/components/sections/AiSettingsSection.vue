<script setup lang="ts">
import { Bot, DownloadCloud } from '@lucide/vue'
import { computed } from 'vue'

import { NButton, NIcon, NInput, NSelect } from '@/ui'
import { AI_PROVIDER_CONFIGS, type AiProvider } from '@/models/ai/ai'
import { resolveProviderCapabilities } from '@/models/agent/providerCapabilities'
import { useSettingsSectionContext } from './settingsSectionContext'

const {
  aiSettings,
  isFetchingAiModels,
  aiModelFetchStatus,
  aiModelSelectOptions,
  updateAi,
  updateAiProvider,
  fetchAiModels,
  updateAiTemperature,
  updateAiTopP,
  updateAiMaxTokens,
} = useSettingsSectionContext()
const capabilities = computed(() =>
  resolveProviderCapabilities(aiSettings.value.provider, aiSettings.value.model),
)
</script>

<template>
  <section id="settings-ai" class="settings-section">
    <header class="settings-section__header">
      <span><Bot :size="18" /></span>
      <div>
        <h2>AI 配置</h2>
        <p>悬浮聊天窗会使用这里的模型和提示词。</p>
      </div>
    </header>
    <div class="settings-card">
      <div class="settings-row">
        <span><strong>服务商</strong><small>决定请求路由和参数兼容方式。</small></span>
        <NSelect
          :value="aiSettings.provider"
          :options="AI_PROVIDER_CONFIGS"
          @update:value="updateAiProvider($event as AiProvider)"
        />
      </div>
      <div class="settings-row">
        <span
          ><strong>Endpoint</strong
          ><small>OpenAI/DeepSeek/千问走 chat/completions；Anthropic 走 messages。</small></span
        >
        <NInput
          :value="aiSettings.endpoint"
          placeholder="https://api.openai.com/v1"
          @update:value="updateAi('endpoint', $event)"
        />
      </div>
      <div class="settings-row settings-row--stacked">
        <span
          ><strong>模型</strong><small>可手动输入，也可以从目标 Endpoint 主动获取。</small></span
        >
        <div class="settings-ai-model-controls">
          <NInput
            :value="aiSettings.model"
            placeholder="先获取或输入模型名"
            @update:value="updateAi('model', $event)"
          />
          <NButton secondary :loading="isFetchingAiModels" @click="fetchAiModels">
            <template #icon>
              <NIcon :size="15"><DownloadCloud /></NIcon>
            </template>
            获取模型
          </NButton>
          <NSelect
            v-if="aiModelSelectOptions.length > 0"
            :value="aiSettings.model"
            :options="aiModelSelectOptions"
            @update:value="updateAi('model', $event)"
          />
        </div>
        <small v-if="aiModelFetchStatus" class="settings-ai-model-status">{{
          aiModelFetchStatus
        }}</small>
      </div>
      <div class="settings-row">
        <span
          ><strong>API Key</strong
          ><small>使用 AES-256-GCM 加密，数据密钥由系统凭据库保护。</small></span
        >
        <NInput
          :value="aiSettings.apiKey"
          type="password"
          placeholder="sk-..."
          @update:value="updateAi('apiKey', $event)"
        />
      </div>
      <div v-if="capabilities.temperature" class="settings-row">
        <span><strong>温度</strong><small>0 更稳定，2 更发散。</small></span>
        <NInput
          :value="String(aiSettings.temperature)"
          type="number"
          min="0"
          max="2"
          step="0.1"
          @update:value="updateAiTemperature"
        />
      </div>
      <div v-if="capabilities.topP" class="settings-row">
        <span><strong>Top P</strong><small>控制采样范围，1 表示不额外限制。</small></span>
        <NInput
          :value="String(aiSettings.topP)"
          type="number"
          min="0"
          max="1"
          step="0.05"
          @update:value="updateAiTopP"
        />
      </div>
      <div class="settings-row">
        <span
          ><strong>最大输出</strong><small>OpenAI-compatible 与 Anthropic 都会使用。</small></span
        >
        <NInput
          :value="String(aiSettings.maxTokens)"
          type="number"
          min="1"
          step="256"
          @update:value="updateAiMaxTokens"
        />
      </div>
      <div class="settings-row settings-row--stacked">
        <span><strong>模型能力</strong><small>由 Provider/Model Capability Matrix 驱动。</small></span>
        <small class="settings-ai-model-status">
          Tools {{ capabilities.toolChoice ? '✓' : '—' }} · Structured Output {{ capabilities.structuredOutput ? '✓' : '—' }} · Reasoning {{ capabilities.reasoningEffort ? '✓' : '—' }} · Streaming {{ capabilities.streaming ? '✓' : '—' }}
        </small>
      </div>
      <div class="settings-row settings-row--stacked">
        <span><strong>系统提示词</strong><small>控制 AI 输出的 Markdown 风格和边界。</small></span>
        <textarea
          class="settings-textarea"
          :value="aiSettings.systemPrompt"
          rows="4"
          aria-label="AI 系统提示词"
          @input="
            updateAi(
              'systemPrompt',
              ($event.target as InstanceType<typeof globalThis.HTMLTextAreaElement>).value,
            )
          "
        ></textarea>
      </div>
    </div>
  </section>
</template>
