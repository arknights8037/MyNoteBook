<script setup lang="ts">
import { ref, toRefs, watch } from 'vue'

import type { AiProvider, AiReasoningEffort, AiSettings } from '@/models/ai'
import type { AgentProject } from '@/models/aiChatHistory'
import type { AgentRuntimeViewState } from '@/models/agentRuntime'
import type { ReviewIssue } from '@/models/cognitive'
import type { AiChatMode, AiSelectorOption } from '@/models/aiChatMode'
import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agentTarget'
import AiChatComposer from './AiChatComposer.vue'
import AiChatHistorySidebar from './AiChatHistorySidebar.vue'
import AiChatMessageList from './AiChatMessageList.vue'
import AiChatPanelHeader from './AiChatPanelHeader.vue'
import AiProjectCreateModal from './AiProjectCreateModal.vue'
import type {
  AiChatPanelHistoryItem,
  AiChatPanelMessage,
  AiChatWorkspaceOption,
} from './aiChatPanelTypes'
import { useFloatingAiChatPanel } from './useFloatingAiChatPanel'

const props = withDefaults(
  defineProps<{
    workspace: boolean
    docked?: boolean
    mode: AiChatMode
    modeLabel: string
    modeOptions: Array<AiSelectorOption<AiChatMode>>
    providerLabel: string
    providerOptions: Array<AiSelectorOption<AiProvider> & { endpoint: string; models: string[] }>
    reasoningLabel: string
    reasoningOptions: Array<AiSelectorOption<AiReasoningEffort>>
    modelOptions: string[]
    settings: AiSettings
    messages: AiChatPanelMessage[]
    chatHistory?: AiChatPanelHistoryItem[]
    projects?: AgentProject[]
    currentProjectId?: string
    workspaceOptions?: AiChatWorkspaceOption[]
    currentWorkspaceRootIds?: string[]
    currentHistoryId?: string | null
    currentDocumentTitle: string
    knowledgeSourceCount: number
    prompt: string
    promptPlaceholder: string
    error: string
    isRunning: boolean
    agentStep?: string
    runtimeState: AgentRuntimeViewState
    renderMarkdownMessage: (markdown: string) => string
    targetOptions?: AgentTargetOption[]
    explicitTargets?: AgentExplicitTarget[]
  }>(),
  {
    chatHistory: () => [],
    projects: () => [],
    currentProjectId: '',
    workspaceOptions: () => [],
    currentWorkspaceRootIds: () => [],
    currentHistoryId: null,
    agentStep: '',
    docked: false,
    targetOptions: () => [],
    explicitTargets: () => [],
  },
)

const emit = defineEmits<{
  'update:prompt': [value: string]
  'select-mode': [mode: AiChatMode]
  'select-provider': [provider: AiProvider]
  'select-model': [model: string]
  'select-reasoning': [reasoningEffort: AiReasoningEffort]
  'toggle-workspace': [workspace: boolean]
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
  'select-history': [historyId: string]
  'delete-history': [historyId: string]
  'select-project': [projectId: string]
  'create-project': [input: { name: string; workspaceRootIds: string[] }]
  'new-task': [projectId: string | null]
  'pin-project': [projectId: string]
  'pin-history': [historyId: string]
  'move-history': [historyId: string, projectId: string]
  'rename-project': [projectId: string, name: string]
  'update-workspace': [projectId: string, rootIds: string[]]
  close: []
  run: []
  stop: []
  clear: []
  insert: [content: string]
  'select-target': [target: AgentTargetOption]
  'clear-target': [targetId: string]
}>()

const HISTORY_COLLAPSED_STORAGE_KEY = 'my-notebook:agent-history-collapsed'
const { workspace, docked } = toRefs(props)
const historyCollapsed = ref(readHistoryCollapsed())
const showProjectCreator = ref(false)
const { floatingWindowStyle, panelElement, resizeDirections, startWindowDrag, startWindowResize } =
  useFloatingAiChatPanel(workspace, docked)

function readHistoryCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(HISTORY_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function toggleHistoryCollapsed(): void {
  historyCollapsed.value = !historyCollapsed.value
}

function openSource(documentId: string, blockId?: string): void {
  emit('open-source', documentId, blockId)
}

function moveHistory(historyId: string, projectId: string): void {
  emit('move-history', historyId, projectId)
}

function renameProject(projectId: string, name: string): void {
  emit('rename-project', projectId, name)
}

function updateWorkspace(projectId: string, rootIds: string[]): void {
  emit('update-workspace', projectId, rootIds)
}

watch(historyCollapsed, (collapsed) => {
  try {
    globalThis.localStorage?.setItem(HISTORY_COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {
    // Storage is optional in embedded/webview privacy modes.
  }
})
</script>

<template>
  <section
    ref="panelElement"
    class="ai-chat-popover"
    :class="{
      'ai-chat-popover--workspace': workspace,
      'ai-chat-popover--docked': docked && !workspace,
    }"
    :style="floatingWindowStyle"
    aria-label="AI 聊天"
  >
    <AiChatPanelHeader
      :workspace="workspace"
      :docked="docked"
      :history-collapsed="historyCollapsed"
      :chat-history="chatHistory"
      :provider-label="providerLabel"
      :model="settings.model"
      @pointer-down="startWindowDrag"
      @toggle-history="toggleHistoryCollapsed"
      @select-history="emit('select-history', $event)"
      @delete-history="emit('delete-history', $event)"
      @toggle-workspace="emit('toggle-workspace', !workspace)"
      @close="emit('close')"
    />

    <template v-if="!workspace && !docked">
      <span
        v-for="direction in resizeDirections"
        :key="direction"
        class="ai-chat-popover__resize-handle"
        :class="`ai-chat-popover__resize-handle--${direction}`"
        aria-hidden="true"
        @pointerdown="startWindowResize(direction, $event)"
      ></span>
    </template>

    <div
      class="ai-chat-popover__body"
      :class="{ 'ai-chat-popover__body--history-collapsed': historyCollapsed }"
    >
      <AiChatHistorySidebar
        v-if="workspace || docked"
        :collapsed="historyCollapsed"
        :chat-history="chatHistory"
        :projects="projects"
        :current-project-id="currentProjectId"
        :workspace-options="workspaceOptions"
        :current-workspace-root-ids="currentWorkspaceRootIds"
        :current-history-id="currentHistoryId"
        @toggle-collapsed="toggleHistoryCollapsed"
        @create-project="showProjectCreator = true"
        @select-history="emit('select-history', $event)"
        @delete-history="emit('delete-history', $event)"
        @select-project="emit('select-project', $event)"
        @new-task="emit('new-task', $event)"
        @pin-project="emit('pin-project', $event)"
        @pin-history="emit('pin-history', $event)"
        @move-history="moveHistory"
        @rename-project="renameProject"
        @update-workspace="updateWorkspace"
      />

      <div class="ai-chat-popover__main">
        <AiChatMessageList
          :messages="messages"
          :current-document-title="currentDocumentTitle"
          :knowledge-source-count="knowledgeSourceCount"
          :provider-label="providerLabel"
          :settings="settings"
          :is-running="isRunning"
          :agent-step="agentStep"
          :runtime-state="runtimeState"
          :render-markdown-message="renderMarkdownMessage"
          @select-mode="emit('select-mode', $event)"
          @use-prompt="emit('update:prompt', $event)"
          @stop="emit('stop')"
          @insert="emit('insert', $event)"
          @fork-message="emit('fork-message', $event)"
          @edit-message="emit('edit-message', $event)"
          @retry-message="emit('retry-message', $event)"
          @copy-message="emit('copy-message', $event)"
          @write-message-to-child="emit('write-message-to-child', $event)"
          @open-source="openSource"
          @research-candidate-action="emit('research-candidate-action', $event)"
          @resolve-review-issue="emit('resolve-review-issue', $event)"
        />

        <p v-if="error" class="ai-chat-popover__error">{{ error }}</p>

        <AiChatComposer
          :mode="mode"
          :mode-label="modeLabel"
          :mode-options="modeOptions"
          :provider-label="providerLabel"
          :provider-options="providerOptions"
          :reasoning-label="reasoningLabel"
          :reasoning-options="reasoningOptions"
          :model-options="modelOptions"
          :settings="settings"
          :prompt="prompt"
          :prompt-placeholder="promptPlaceholder"
          :knowledge-source-count="knowledgeSourceCount"
          :target-options="targetOptions"
          :explicit-targets="explicitTargets"
          :can-clear="messages.length > 0 || Boolean(error)"
          :is-running="isRunning"
          @update:prompt="emit('update:prompt', $event)"
          @select-mode="emit('select-mode', $event)"
          @select-provider="emit('select-provider', $event)"
          @select-model="emit('select-model', $event)"
          @select-reasoning="emit('select-reasoning', $event)"
          @select-target="emit('select-target', $event)"
          @clear-target="emit('clear-target', $event)"
          @run="emit('run')"
          @stop="emit('stop')"
          @clear="emit('clear')"
        />
      </div>
    </div>

    <AiProjectCreateModal
      v-model:show="showProjectCreator"
      :workspace-options="workspaceOptions"
      :project-count="projects.length"
      @create="emit('create-project', $event)"
    />
  </section>
</template>
