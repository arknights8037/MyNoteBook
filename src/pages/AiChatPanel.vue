<script setup lang="ts">
import { Check, ChevronDown, Maximize2, Minimize2, X } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { computed } from 'vue'

import type { AiProvider, AiReasoningEffort, AiSettings } from '@/models/ai'

type AiChatMode = 'ask' | 'edit'
type AiChatRole = 'user' | 'assistant'
type AiChatStatus = 'streaming' | 'done' | 'error'

interface AiSelectorOption<T extends string> {
  value: T
  label: string
  description?: string
}

interface AiChatMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  status: AiChatStatus
}

const props = defineProps<{
  workspace: boolean
  mode: AiChatMode
  modeLabel: string
  modeOptions: Array<AiSelectorOption<AiChatMode>>
  providerLabel: string
  providerOptions: Array<AiSelectorOption<AiProvider> & { endpoint: string; models: string[] }>
  reasoningLabel: string
  reasoningOptions: Array<AiSelectorOption<AiReasoningEffort>>
  modelOptions: string[]
  settings: AiSettings
  messages: AiChatMessage[]
  prompt: string
  promptPlaceholder: string
  error: string
  isRunning: boolean
  renderMarkdownMessage: (markdown: string) => string
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  'select-mode': [mode: AiChatMode]
  'select-provider': [provider: AiProvider]
  'select-model': [model: string]
  'select-reasoning': [reasoningEffort: AiReasoningEffort]
  'toggle-workspace': [workspace: boolean]
  close: []
  run: []
  stop: []
  clear: []
  insert: [content: string]
}>()

const knownProviderModels = computed(
  () =>
    props.providerOptions.find((option) => option.value === props.settings.provider)?.models ?? [],
)

function updatePrompt(event: InstanceType<typeof globalThis.Event>): void {
  const target = event.target as { value?: string } | null
  emit('update:prompt', target?.value ?? '')
}
</script>

<template>
  <section
    class="ai-chat-popover"
    :class="{ 'ai-chat-popover--workspace': workspace }"
    aria-label="AI 聊天"
  >
    <header class="ai-chat-popover__header">
      <div class="ai-chat-popover__heading">
        <strong>AI Markdown 助手</strong>
        <span>{{ providerLabel }} · {{ settings.model }}</span>
      </div>
      <div class="ai-chat-popover__window-actions">
        <button
          type="button"
          class="ai-chat-popover__icon-button"
          :aria-label="workspace ? '还原悬浮 AI 聊天' : '在文档区打开 AI 聊天'"
          @click="emit('toggle-workspace', !workspace)"
        >
          <Minimize2 v-if="workspace" :size="15" />
          <Maximize2 v-else :size="15" />
        </button>
        <button
          type="button"
          class="ai-chat-popover__icon-button"
          aria-label="关闭 AI 聊天"
          @click="emit('close')"
        >
          <X :size="16" />
        </button>
      </div>
    </header>

    <div class="ai-chat-popover__messages" aria-live="polite">
      <p v-if="messages.length === 0" class="ai-chat-popover__empty">
        Ask 会在这里流式回答；Edit 会把完整 Markdown 块同步写入当前文档。
      </p>
      <article
        v-for="chatMessage in messages"
        :key="chatMessage.id"
        class="ai-chat-message"
        :class="[
          `ai-chat-message--${chatMessage.role}`,
          { 'ai-chat-message--streaming': chatMessage.status === 'streaming' },
          { 'ai-chat-message--error': chatMessage.status === 'error' },
        ]"
      >
        <header>
          <span>{{ chatMessage.role === 'user' ? '你' : 'AI' }}</span>
          <em>{{ chatMessage.mode === 'ask' ? 'ask' : 'edit' }}</em>
        </header>
        <div class="markdown-preview" v-html="renderMarkdownMessage(chatMessage.content)"></div>
        <footer v-if="chatMessage.role === 'assistant' && chatMessage.content.trim()">
          <button
            v-if="chatMessage.mode === 'ask'"
            type="button"
            @click="emit('insert', chatMessage.content)"
          >
            插入
          </button>
          <span v-else>已同步到文档</span>
          <span v-if="chatMessage.status === 'streaming'">输出中</span>
        </footer>
      </article>
    </div>

    <p v-if="error" class="ai-chat-popover__error">{{ error }}</p>

    <form class="ai-chat-composer" @submit.prevent="emit('run')">
      <div class="ai-chat-input-shell">
        <textarea
          :value="prompt"
          rows="3"
          :placeholder="promptPlaceholder"
          aria-label="AI 输入"
          @input="updatePrompt"
          @keydown.enter.exact.prevent="emit('run')"
        ></textarea>

        <div class="ai-chat-composer__bar">
          <div class="ai-chat-composer__toolbar" aria-label="AI 输入选项">
            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector ai-chat-selector--primary">
                  <span>{{ modeLabel }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="ai-chat-menu" align="start" :side-offset="6">
                  <DropdownMenuItem
                    v-for="option in modeOptions"
                    :key="option.value"
                    class="ai-chat-menu__item"
                    :class="{ 'ai-chat-menu__item--active': mode === option.value }"
                    @select="emit('select-mode', option.value)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ option.label }}</strong>
                      <small>{{ option.description }}</small>
                    </span>
                    <Check v-if="mode === option.value" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector">
                  <span>{{ providerLabel }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="ai-chat-menu" align="start" :side-offset="6">
                  <DropdownMenuItem
                    v-for="option in providerOptions"
                    :key="option.value"
                    class="ai-chat-menu__item"
                    :class="{ 'ai-chat-menu__item--active': settings.provider === option.value }"
                    @select="emit('select-provider', option.value)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ option.label }}</strong>
                      <small>{{ option.description }}</small>
                    </span>
                    <Check v-if="settings.provider === option.value" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector ai-chat-selector--model">
                  <span>{{ settings.model }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  class="ai-chat-menu ai-chat-menu--model"
                  align="start"
                  :side-offset="6"
                >
                  <DropdownMenuItem
                    v-for="model in modelOptions"
                    :key="model"
                    class="ai-chat-menu__item"
                    :class="{ 'ai-chat-menu__item--active': settings.model === model }"
                    @select="emit('select-model', model)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ model }}</strong>
                      <small v-if="!knownProviderModels.includes(model)">当前自定义模型</small>
                    </span>
                    <Check v-if="settings.model === model" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector">
                  <span>{{ reasoningLabel }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="ai-chat-menu" align="start" :side-offset="6">
                  <DropdownMenuItem
                    v-for="option in reasoningOptions"
                    :key="option.value"
                    class="ai-chat-menu__item"
                    :class="{
                      'ai-chat-menu__item--active': settings.reasoningEffort === option.value,
                    }"
                    @select="emit('select-reasoning', option.value)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ option.label }}</strong>
                      <small>{{ option.description }}</small>
                    </span>
                    <Check v-if="settings.reasoningEffort === option.value" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </div>

          <div class="ai-chat-composer__actions">
            <button type="button" :disabled="messages.length === 0 && !error" @click="emit('clear')">
              清空
            </button>
            <button v-if="isRunning" type="button" @click="emit('stop')">停止</button>
            <button type="submit" :disabled="isRunning || !prompt.trim()">
              {{ mode === 'edit' ? '编辑' : '发送' }}
            </button>
          </div>
        </div>
      </div>
    </form>
  </section>
</template>
