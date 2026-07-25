<script setup lang="ts">
import {
  AtSign,
  Bot,
  Database,
  FilePlus2,
  FileText,
  ListChecks,
  MessageCircleQuestion,
  SearchCheck,
  Send,
  Square,
  X,
} from '@lucide/vue'
import { computed, nextTick, ref, toRef } from 'vue'

import type { AiProvider, AiReasoningEffort, AiSettings } from '@/models/ai/ai'
import type { AiChatMode, AiSelectorOption } from '@/models/ai/aiChatMode'
import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agent/agentTarget'
import type { AgentSlashCommand } from '@/models/agent/agentSlashCommand'
import { resolveProviderCapabilities } from '@/models/agent/providerCapabilities'

import AiChatComposerDropdown from './AiChatComposerDropdown.vue'
import { useComposerMenus } from './useComposerMenus'

type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>
type BrowserTextAreaElement = InstanceType<typeof globalThis.HTMLTextAreaElement>

const props = defineProps<{
  mode: AiChatMode
  modeLabel: string
  modeOptions: Array<AiSelectorOption<AiChatMode>>
  providerLabel: string
  providerOptions: Array<AiSelectorOption<AiProvider> & { endpoint: string; models: string[] }>
  reasoningLabel: string
  reasoningOptions: Array<AiSelectorOption<AiReasoningEffort>>
  modelOptions: string[]
  settings: AiSettings
  prompt: string
  promptPlaceholder: string
  knowledgeSourceCount: number
  targetOptions: AgentTargetOption[]
  explicitTargets: AgentExplicitTarget[]
  canClear: boolean
  isRunning: boolean
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  'select-mode': [mode: AiChatMode]
  'select-provider': [provider: AiProvider]
  'select-model': [model: string]
  'select-reasoning': [reasoningEffort: AiReasoningEffort]
  'select-target': [target: AgentTargetOption]
  'clear-target': [targetId: string]
  run: []
  stop: []
  clear: []
}>()

const composerElement = ref<BrowserTextAreaElement | null>(null)

const providerCapabilities = computed(() =>
  resolveProviderCapabilities(props.settings.provider, props.settings.model),
)

const menus = useComposerMenus({
  prompt: toRef(props, 'prompt'),
  targetOptions: toRef(props, 'targetOptions'),
  explicitTargets: toRef(props, 'explicitTargets'),
  focusComposer: () => composerElement.value?.focus(),
})

// --- Dropdown option adapters ---

const modeDropdownOptions = computed(() =>
  props.modeOptions.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  })),
)
const providerDropdownOptions = computed(() =>
  props.providerOptions.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  })),
)
const modelDropdownOptions = computed(() =>
  props.modelOptions.map((model) => ({ value: model, label: model })),
)
const reasoningDropdownOptions = computed(() =>
  props.reasoningOptions.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  })),
)

// --- Event handlers ---

function updatePrompt(event: BrowserEvent): void {
  const target = event.target as BrowserTextAreaElement | null
  emit('update:prompt', target?.value ?? '')
  menus.resetMenus()
  resizeComposer(target)
}

function resizeComposer(target: BrowserTextAreaElement | null): void {
  if (!target) return
  target.style.height = 'auto'
  target.style.height = `${Math.min(target.scrollHeight, 220)}px`
}

function handleComposerKeydown(event: BrowserKeyboardEvent): void {
  if (
    menus.handleMenuKeydown(event, {
      onSelectTarget: selectTarget,
      onSelectSlashCommand: selectSlashCommand,
    })
  ) {
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (!props.isRunning && props.prompt.trim()) emit('run')
}

function openTargetMenu(): void {
  emit('update:prompt', menus.openTargetMenu(props.prompt))
}

function selectTarget(target: AgentTargetOption): void {
  const nextPrompt = props.prompt.replace(/(?:^|\s)@[^\s@]*$/, (match) => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}@${target.title} `
  })
  emit('update:prompt', nextPrompt)
  emit('select-target', target)
  menus.dismissTargetMenu()
}

function openSlashMenu(): void {
  emit('update:prompt', '/')
  menus.openSlashMenu()
}

function selectSlashCommand(command: AgentSlashCommand): void {
  emit('select-mode', command.mode)
  emit('update:prompt', `/${command.name} `)
  menus.dismissSlashMenu()
}

function slashCommandIcon(command: AgentSlashCommand) {
  return (
    {
      plan: ListChecks,
      create: FilePlus2,
      interactive: MessageCircleQuestion,
      research: SearchCheck,
    }[command.name] ?? Bot
  )
}
</script>

<template>
  <form class="ai-chat-composer" @submit.prevent="emit('run')">
    <div class="ai-chat-input-shell">
      <div
        v-if="menus.filteredTargetOptions.value.length"
        class="ai-slash-menu ai-target-menu"
        role="listbox"
        aria-label="选择目标文件"
      >
        <button
          v-for="(target, index) in menus.filteredTargetOptions.value"
          :key="`${target.kind}:${target.id}`"
          type="button"
          role="option"
          :aria-selected="menus.targetSelectedIndex.value === index"
          :class="{ 'is-active': menus.targetSelectedIndex.value === index }"
          @mouseenter="menus.targetSelectedIndex.value = index"
          @click="selectTarget(target)"
        >
          <span><FileText :size="16" /></span>
          <span
            ><strong>{{ target.title }}</strong
            ><small>{{ target.subtitle }}</small></span
          >
        </button>
      </div>
      <div
        v-if="menus.slashCommands.value.length"
        class="ai-slash-menu"
        role="listbox"
        aria-label="Agent 功能"
      >
        <span class="ui-visually-hidden">使用上下方向键选择，Enter 确认</span>
        <button
          v-for="(command, index) in menus.slashCommands.value"
          :key="command.name"
          type="button"
          role="option"
          :aria-selected="menus.slashSelectedIndex.value === index"
          :class="{ 'is-active': menus.slashSelectedIndex.value === index }"
          @mouseenter="menus.slashSelectedIndex.value = index"
          @click="selectSlashCommand(command)"
        >
          <span><component :is="slashCommandIcon(command)" :size="16" /></span>
          <span
            ><strong>/{{ command.name }} · {{ command.label }}</strong
            ><small>{{ command.description }}</small></span
          >
        </button>
      </div>
      <textarea
        ref="composerElement"
        :value="prompt"
        rows="3"
        :placeholder="menus.activeSlashCommand.value?.placeholder || promptPlaceholder"
        aria-label="AI 输入"
        @input="updatePrompt"
        @keydown="handleComposerKeydown"
      ></textarea>

      <div v-if="explicitTargets.length" class="ai-chat-targets" aria-label="Research 目标">
        <div
          v-for="target in explicitTargets"
          :key="`${target.kind}:${target.id}`"
          class="ai-chat-target-chip"
        >
          <AtSign :size="14" />
          <span>{{ target.title }}</span>
          <button
            type="button"
            :aria-label="`移除目标 ${target.title}`"
            title="移除目标"
            @click="emit('clear-target', target.id)"
          >
            <X :size="13" />
          </button>
        </div>
      </div>

      <div class="ai-chat-composer__bar">
        <div class="ai-chat-composer__toolbar" aria-label="AI 输入选项">
          <button
            type="button"
            class="ai-chat-selector ai-chat-selector--slash"
            aria-label="打开 Agent 斜杠菜单"
            title="Agent 斜杠菜单"
            @click="openSlashMenu"
          >
            /
          </button>
          <button
            type="button"
            class="ai-chat-selector"
            aria-label="选择目标文件"
            title="选择目标文件"
            @click="openTargetMenu"
          >
            <AtSign :size="15" />
          </button>

          <AiChatComposerDropdown
            :options="modeDropdownOptions"
            :selected="mode"
            :trigger-label="modeLabel"
            trigger-class="ai-chat-selector--primary"
            @select="emit('select-mode', $event as AiChatMode)"
          />
          <AiChatComposerDropdown
            :options="providerDropdownOptions"
            :selected="settings.provider"
            :trigger-label="providerLabel"
            @select="emit('select-provider', $event as AiProvider)"
          />
          <AiChatComposerDropdown
            :options="modelDropdownOptions"
            :selected="settings.model"
            :trigger-label="settings.model || '选择模型'"
            trigger-class="ai-chat-selector--model"
            menu-class="ai-chat-menu--model"
            @select="emit('select-model', $event)"
          />
          <AiChatComposerDropdown
            v-if="providerCapabilities.reasoningEffort"
            :options="reasoningDropdownOptions"
            :selected="settings.reasoningEffort"
            :trigger-label="reasoningLabel"
            @select="emit('select-reasoning', $event as AiReasoningEffort)"
          />
        </div>

        <div class="ai-chat-composer__actions">
          <button type="button" :disabled="!canClear" @click="emit('clear')">清空</button>
          <button
            v-if="isRunning"
            type="button"
            class="ai-chat-composer__stop"
            aria-label="停止生成"
            title="停止生成"
            @click="emit('stop')"
          >
            <Square :size="13" fill="currentColor" />
          </button>
          <button
            v-else
            type="submit"
            :disabled="!prompt.trim()"
            :aria-label="mode === 'agent' ? '执行 Agent' : '发送消息'"
            :title="mode === 'agent' ? '执行 Agent' : '发送消息'"
          >
            <Send :size="15" />
          </button>
        </div>
      </div>
      <p class="ai-chat-composer__hint">
        <span v-if="menus.activeSlashCommand.value" class="ai-chat-composer__command"
          >/{{ menus.activeSlashCommand.value.name }} ·
          {{ menus.activeSlashCommand.value.label }}</span
        >
        <span><Database :size="13" />已装载当前页面与 {{ knowledgeSourceCount }} 篇知识库资料</span>
      </p>
    </div>
  </form>
</template>
