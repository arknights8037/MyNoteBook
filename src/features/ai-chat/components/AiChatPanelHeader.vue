<script setup lang="ts">
import {
  History,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  X,
} from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'

import type { AiChatPanelHistoryItem } from './aiChatPanelTypes'

type BrowserPointerEvent = InstanceType<typeof globalThis.PointerEvent>

defineProps<{
  workspace: boolean
  docked: boolean
  historyCollapsed: boolean
  chatHistory: AiChatPanelHistoryItem[]
  providerLabel: string
  model: string
}>()

const emit = defineEmits<{
  'toggle-history': []
  'select-history': [historyId: string]
  'delete-history': [historyId: string]
  'toggle-workspace': []
  close: []
  'pointer-down': [event: BrowserPointerEvent]
}>()

function formatHistoryTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}
</script>

<template>
  <header
    class="ai-chat-popover__header"
    :class="{ 'ai-chat-popover__header--draggable': !workspace && !docked }"
    @pointerdown="emit('pointer-down', $event)"
  >
    <div class="ai-chat-popover__heading">
      <strong>知识库 Agent</strong>
      <span>{{ providerLabel }} · {{ model || '未选择模型' }}</span>
    </div>
    <div class="ai-chat-popover__window-actions">
      <button
        v-if="workspace || docked"
        type="button"
        class="ai-chat-popover__icon-button"
        :aria-label="historyCollapsed ? '展开对话历史' : '折叠对话历史'"
        :title="historyCollapsed ? '展开对话历史' : '折叠对话历史'"
        @click="emit('toggle-history')"
      >
        <PanelLeftOpen v-if="historyCollapsed" :size="15" />
        <PanelLeftClose v-else :size="15" />
      </button>
      <DropdownMenuRoot v-else>
        <DropdownMenuTrigger as-child>
          <button type="button" class="ai-chat-popover__icon-button" aria-label="聊天记录">
            <History :size="15" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            class="ai-chat-menu ai-chat-history-menu"
            align="end"
            :side-offset="6"
          >
            <div v-if="chatHistory.length === 0" class="ai-chat-history-menu__empty">
              暂无聊天记录
            </div>
            <DropdownMenuItem
              v-for="historyItem in chatHistory"
              :key="historyItem.id"
              class="ai-chat-menu__item ai-chat-history-menu__item"
              @select="emit('select-history', historyItem.id)"
            >
              <span class="ai-chat-history-menu__copy">
                <strong>{{ historyItem.title }}</strong>
                <small
                  >{{ formatHistoryTime(historyItem.updatedAt) }} ·
                  {{ historyItem.messageCount }} 条 · {{ historyItem.model }}</small
                >
              </span>
              <button
                type="button"
                class="ai-chat-history-menu__delete"
                :aria-label="`删除聊天记录：${historyItem.title}`"
                @pointerdown.stop
                @click.stop.prevent="emit('delete-history', historyItem.id)"
              >
                <Trash2 :size="13" />
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      <button
        type="button"
        class="ai-chat-popover__icon-button"
        :aria-label="workspace ? '还原为侧边 AI 面板' : '在文档区打开 AI 聊天'"
        @click="emit('toggle-workspace')"
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
</template>
