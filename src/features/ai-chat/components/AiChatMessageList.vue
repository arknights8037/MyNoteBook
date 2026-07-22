<script setup lang="ts">
import {
  ArrowDown,
  BookOpen,
  Brain,
  ChevronDown,
  Copy,
  Database,
  FileText,
  GitFork,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Sparkles,
} from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'

import type { AiSettings } from '@/models/ai/ai'
import type { AgentRuntimeViewState } from '@/models/agent/agentRuntime'
import type { ReviewIssue } from '@/models/cognitive/cognitive'
import { parseInternalDocumentHref } from '@/models/documents/documentLink'
import AiAgentRuntimeTrace from './AiAgentRuntimeTrace.vue'
import type { AiChatPanelMessage } from './aiChatPanelTypes'
import AiStructuredMessageResults from './AiStructuredMessageResults.vue'

type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>
type AiChatMessage = AiChatPanelMessage

const props = defineProps<{
  messages: AiChatPanelMessage[]
  currentDocumentTitle: string
  knowledgeSourceCount: number
  providerLabel: string
  settings: AiSettings
  isRunning: boolean
  agentStep: string
  runtimeState: AgentRuntimeViewState
  renderMarkdownMessage: (markdown: string) => string
}>()

const emit = defineEmits<{
  'select-mode': [mode: 'ask']
  stop: []
  insert: [content: string]
  'fork-message': [messageId: string]
  'edit-message': [messageId: string]
  'retry-message': [messageId: string]
  'copy-message': [content: string]
  'write-message-to-child': [content: string]
  'open-source': [documentId: string, blockId?: string]
  'research-candidate-action': [
    input: {
      messageId: string
      itemId: string
      candidateId: string
      expectedVersion: number
      action: 'keep' | 'approve' | 'reject'
      title?: string
      content?: string
    },
  ]
  'resolve-review-issue': [input: { messageId: string; issue: ReviewIssue }]
  'use-prompt': [prompt: string]
}>()

const quickPrompts = [
  { label: '提炼要点', prompt: '请提炼当前页面的核心观点，并用 3–5 条要点说明。' },
  { label: '查找关联资料', prompt: '请从知识库中找出与当前页面最相关的资料，并说明关联原因。' },
  { label: '提取行动项', prompt: '请从当前页面提取待办、决策和后续行动项。' },
  { label: '整理为提纲', prompt: '请将当前页面整理成层级清晰的 Markdown 提纲。' },
]
const messagesElement = ref<BrowserHTMLElement | null>(null)
const isFollowingOutput = ref(true)
let shouldKeepMessagesAtBottom = true

const showRuntimeState = computed(
  () =>
    props.runtimeState.status !== 'idle' &&
    (props.isRunning ||
      props.runtimeState.toolCalls.length > 0 ||
      props.runtimeState.status === 'failed' ||
      props.runtimeState.status === 'cancelled'),
)
const runtimeMessageId = computed(
  () => [...props.messages].reverse().find((message) => message.role === 'assistant')?.id ?? null,
)

function isAssistantMessage(chatMessage: AiChatMessage): boolean {
  return chatMessage.role === 'assistant'
}

function isRuntimeHostMessage(chatMessage: AiChatMessage): boolean {
  return Boolean(getMessageRuntime(chatMessage))
}

function getMessageRuntime(chatMessage: AiChatMessage): AgentRuntimeViewState | null {
  if (props.isRunning && showRuntimeState.value && chatMessage.id === runtimeMessageId.value) {
    return props.runtimeState
  }
  return chatMessage.role === 'assistant' ? (chatMessage.agentRuntime ?? null) : null
}

function hasMessageOutput(chatMessage: AiChatMessage): boolean {
  return Boolean(chatMessage.content.trim() || chatMessage.reasoningContent?.trim())
}

function showMessageActions(chatMessage: AiChatMessage): boolean {
  if (chatMessage.status === 'streaming') return false
  return hasMessageOutput(chatMessage)
}

function openSource(documentId: string, blockId?: string): void {
  emit('open-source', documentId, blockId)
}

function handleMarkdownClick(event: InstanceType<typeof globalThis.MouseEvent>): void {
  const target = event.target
  const anchor = target instanceof globalThis.Element ? target.closest('a') : null
  const href = anchor?.getAttribute('href') ?? ''
  const targetDocument = parseInternalDocumentHref(href)
  if (!targetDocument) return

  event.preventDefault()
  if (targetDocument.blockId) emit('open-source', targetDocument.documentId, targetDocument.blockId)
  else emit('open-source', targetDocument.documentId)
}

function handleMessagesScroll(): void {
  const element = messagesElement.value
  if (!element) return
  shouldKeepMessagesAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64
  isFollowingOutput.value = shouldKeepMessagesAtBottom
}

function scrollMessagesToLatest(force = false): void {
  if (!force && !shouldKeepMessagesAtBottom) return
  if (force) {
    shouldKeepMessagesAtBottom = true
    isFollowingOutput.value = true
  }
  void nextTick(() => {
    const element = messagesElement.value
    if (element) {
      element.scrollTo?.({ top: element.scrollHeight, behavior: force ? 'smooth' : 'auto' })
      if (!element.scrollTo) element.scrollTop = element.scrollHeight
    }
  })
}

watch(
  () => props.messages,
  () => scrollMessagesToLatest(),
  { deep: true, flush: 'post' },
)

watch(
  () => props.isRunning,
  (isRunning) => {
    if (isRunning) {
      shouldKeepMessagesAtBottom = true
      isFollowingOutput.value = true
    }
    scrollMessagesToLatest()
  },
  { immediate: true },
)
</script>

<template>
  <div
    ref="messagesElement"
    class="ai-chat-popover__messages"
    aria-live="polite"
    @scroll="handleMessagesScroll"
  >
    <section v-if="messages.length === 0" class="ai-chat-welcome">
      <div class="ai-chat-welcome__mark"><Sparkles :size="21" /></div>
      <div class="ai-chat-welcome__copy">
        <p>开始一次基于知识库的协作</p>
        <span>我会结合当前页面与已收录资料回答；需要改写时切换到 Edit。</span>
      </div>
      <div class="ai-chat-context-card" aria-label="当前知识上下文">
        <div class="ai-chat-context-card__title"><Database :size="15" />知识上下文</div>
        <div class="ai-chat-context-card__row">
          <FileText :size="14" />
          <span class="ai-chat-context-card__document">{{
            currentDocumentTitle || '未命名页面'
          }}</span>
        </div>
        <div class="ai-chat-context-card__meta">
          <BookOpen :size="14" />已连接 {{ knowledgeSourceCount }} 篇资料
        </div>
      </div>
      <div class="ai-chat-quick-prompts" aria-label="常用任务">
        <button
          v-for="quickPrompt in quickPrompts"
          :key="quickPrompt.label"
          type="button"
          @click="useQuickPrompt(quickPrompt.prompt)"
        >
          {{ quickPrompt.label }}
        </button>
      </div>
    </section>
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
        <em>{{ chatMessage.mode }}</em>
      </header>
      <AiAgentRuntimeTrace
        v-if="isRuntimeHostMessage(chatMessage)"
        :state="getMessageRuntime(chatMessage)!"
        :active="isRunning && chatMessage.id === runtimeMessageId"
        :provider-label="providerLabel"
        :model="settings.model"
        :step="agentStep"
        @stop="emit('stop')"
        @open-source="openSource"
      />
      <details
        v-if="chatMessage.reasoningContent?.trim()"
        class="ai-chat-message__reasoning"
        :open="chatMessage.status === 'streaming' && !chatMessage.content.trim()"
      >
        <summary>
          <Brain :size="13" aria-hidden="true" />
          <span>{{ chatMessage.status === 'streaming' ? '正在分析' : '分析过程' }}</span>
          <LoaderCircle
            v-if="chatMessage.status === 'streaming'"
            :size="12"
            class="ai-agent-tool-list__spinner"
            aria-hidden="true"
          />
          <ChevronDown v-else :size="12" aria-hidden="true" />
        </summary>
        <pre>{{ chatMessage.reasoningContent }}</pre>
      </details>
      <!-- renderAiMarkdown emits only allowlisted tags and escapes text, attributes and URLs. -->
      <!-- eslint-disable vue/no-v-html -->
      <AiStructuredMessageResults
        :message="chatMessage"
        :is-running="isRunning"
        @open-source="openSource"
        @research-candidate-action="emit('research-candidate-action', $event)"
        @resolve-review-issue="emit('resolve-review-issue', $event)"
      />
      <div
        v-if="chatMessage.content.trim()"
        class="markdown-preview"
        :aria-busy="chatMessage.status === 'streaming'"
        @click="handleMarkdownClick"
        v-html="renderMarkdownMessage(chatMessage.content)"
      ></div>
      <!-- eslint-enable vue/no-v-html -->
      <div
        v-if="chatMessage.sources?.length"
        class="ai-chat-message__sources"
        aria-label="本次回答使用的文档"
      >
        <span>使用文档</span>
        <button
          v-for="source in chatMessage.sources"
          :key="`${chatMessage.id}-${source.id}`"
          type="button"
          @click="emit('open-source', source.documentId, source.blockId)"
        >
          {{ source.id }} · {{ source.documentTitle }}
        </button>
      </div>
      <div
        v-else-if="chatMessage.status === 'streaming' && !isRuntimeHostMessage(chatMessage)"
        class="ai-chat-message__waiting"
        role="status"
      >
        <span aria-hidden="true"></span>
        <span>{{ chatMessage.reasoningContent?.trim() ? '等待正文输出' : '等待模型响应' }}</span>
      </div>
      <footer
        v-if="showMessageActions(chatMessage)"
        class="ai-chat-message__actions"
        :class="{
          'ai-chat-message__actions--assistant': isAssistantMessage(chatMessage),
          'ai-chat-message__actions--user': !isAssistantMessage(chatMessage),
        }"
      >
        <button
          v-if="isAssistantMessage(chatMessage) && chatMessage.mode === 'ask'"
          type="button"
          :disabled="isRunning"
          @click="emit('insert', chatMessage.content)"
        >
          插入
        </button>
        <span v-else-if="chatMessage.researchResult">调研结果不会自动写入正式知识</span>
        <span v-else-if="chatMessage.reviewResult">审阅结果不会自动修改文档</span>
        <span v-else-if="chatMessage.learningResult">学习状态仅由实际尝试更新</span>
        <span v-else-if="isAssistantMessage(chatMessage)">已生成修改建议</span>
        <template v-if="isAssistantMessage(chatMessage)">
          <button
            v-if="chatMessage.status === 'error'"
            type="button"
            :disabled="isRunning"
            @click="emit('retry-message', chatMessage.id)"
          >
            <RotateCcw :size="13" />重试
          </button>
          <button
            type="button"
            :disabled="isRunning"
            @click="emit('copy-message', chatMessage.content)"
          >
            <Copy :size="13" />复制
          </button>
          <button
            type="button"
            :disabled="isRunning"
            @click="emit('write-message-to-child', chatMessage.content)"
          >
            写入子页面
          </button>
        </template>
        <button type="button" :disabled="isRunning" @click="emit('fork-message', chatMessage.id)">
          <GitFork :size="13" />分支
        </button>
        <button type="button" :disabled="isRunning" @click="emit('edit-message', chatMessage.id)">
          <Pencil :size="13" />修改
        </button>
      </footer>
    </article>
    <button
      v-if="isRunning && !isFollowingOutput"
      type="button"
      class="ai-chat-jump-latest"
      aria-label="回到最新输出"
      @click="scrollMessagesToLatest(true)"
    >
      <ArrowDown :size="14" />
      最新输出
    </button>
  </div>
</template>
