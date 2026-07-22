<script setup lang="ts">
import {
  AtSign,
  Bot,
  Check,
  ChevronDown,
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
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { computed, nextTick, ref } from 'vue'

import type { AiProvider, AiReasoningEffort, AiSettings } from '@/models/ai/ai'
import type { AiChatMode, AiSelectorOption } from '@/models/ai/aiChatMode'
import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agent/agentTarget'
import {
  filterAgentSlashCommands,
  resolveAgentSlashCommand,
  type AgentSlashCommand,
} from '@/models/agent/agentSlashCommand'
import { resolveProviderCapabilities } from '@/models/agent/providerCapabilities'

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
const slashSelectedIndex = ref(0)
const slashMenuDismissed = ref(false)
const targetSelectedIndex = ref(0)
const targetMenuDismissed = ref(false)

const providerCapabilities = computed(() =>
  resolveProviderCapabilities(props.settings.provider, props.settings.model),
)
const slashCommands = computed(() =>
  slashMenuDismissed.value ? [] : filterAgentSlashCommands(props.prompt),
)
const activeSlashCommand = computed(() => resolveAgentSlashCommand(props.prompt)?.command ?? null)
const targetQuery = computed(() => {
  const match = props.prompt.match(/(?:^|\s)@([^\s@]*)$/)
  return match?.[1]?.toLocaleLowerCase() ?? null
})
const filteredTargetOptions = computed(() => {
  if (targetMenuDismissed.value || targetQuery.value === null) return []
  return props.targetOptions
    .filter(
      (option) =>
        !props.explicitTargets.some(
          (target) => target.kind === option.kind && target.id === option.id,
        ),
    )
    .filter((option) =>
      `${option.title} ${option.subtitle}`.toLocaleLowerCase().includes(targetQuery.value ?? ''),
    )
    .slice(0, 8)
})

function updatePrompt(event: BrowserEvent): void {
  const target = event.target as BrowserTextAreaElement | null
  emit('update:prompt', target?.value ?? '')
  slashMenuDismissed.value = false
  slashSelectedIndex.value = 0
  targetMenuDismissed.value = false
  targetSelectedIndex.value = 0
  resizeComposer(target)
}

function resizeComposer(target: BrowserTextAreaElement | null): void {
  if (!target) return
  target.style.height = 'auto'
  target.style.height = `${Math.min(target.scrollHeight, 220)}px`
}

function handleComposerKeydown(event: BrowserKeyboardEvent): void {
  if (filteredTargetOptions.value.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      targetSelectedIndex.value =
        (targetSelectedIndex.value + direction + filteredTargetOptions.value.length) %
        filteredTargetOptions.value.length
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      targetMenuDismissed.value = true
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      const target = filteredTargetOptions.value[targetSelectedIndex.value]
      if (target) selectTarget(target)
      return
    }
  }
  if (slashCommands.value.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      slashSelectedIndex.value =
        (slashSelectedIndex.value + direction + slashCommands.value.length) %
        slashCommands.value.length
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      slashMenuDismissed.value = true
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      const command = slashCommands.value[slashSelectedIndex.value]
      if (command) selectSlashCommand(command)
      return
    }
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (!props.isRunning && props.prompt.trim()) emit('run')
}

function openTargetMenu(): void {
  const separator = props.prompt && !props.prompt.endsWith(' ') ? ' ' : ''
  emit('update:prompt', `${props.prompt}${separator}@`)
  targetMenuDismissed.value = false
  targetSelectedIndex.value = 0
  void nextTick(() => composerElement.value?.focus())
}

function selectTarget(target: AgentTargetOption): void {
  const nextPrompt = props.prompt.replace(/(?:^|\s)@[^\s@]*$/, (match) => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}@${target.title} `
  })
  emit('update:prompt', nextPrompt)
  emit('select-target', target)
  targetMenuDismissed.value = true
  void nextTick(() => composerElement.value?.focus())
}

function openSlashMenu(): void {
  emit('update:prompt', '/')
  slashMenuDismissed.value = false
  slashSelectedIndex.value = 0
  void nextTick(() => composerElement.value?.focus())
}

function selectSlashCommand(command: AgentSlashCommand): void {
  emit('select-mode', command.mode)
  emit('update:prompt', `/${command.name} `)
  slashMenuDismissed.value = true
  void nextTick(() => composerElement.value?.focus())
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
        v-if="filteredTargetOptions.length"
        class="ai-slash-menu ai-target-menu"
        role="listbox"
        aria-label="选择目标文件"
      >
        <button
          v-for="(target, index) in filteredTargetOptions"
          :key="`${target.kind}:${target.id}`"
          type="button"
          role="option"
          :aria-selected="targetSelectedIndex === index"
          :class="{ 'is-active': targetSelectedIndex === index }"
          @mouseenter="targetSelectedIndex = index"
          @click="selectTarget(target)"
        >
          <span><FileText :size="16" /></span>
          <span
            ><strong>{{ target.title }}</strong
            ><small>{{ target.subtitle }}</small></span
          >
        </button>
      </div>
      <div v-if="slashCommands.length" class="ai-slash-menu" role="listbox" aria-label="Agent 功能">
        <span class="ui-visually-hidden">使用上下方向键选择，Enter 确认</span>
        <button
          v-for="(command, index) in slashCommands"
          :key="command.name"
          type="button"
          role="option"
          :aria-selected="slashSelectedIndex === index"
          :class="{ 'is-active': slashSelectedIndex === index }"
          @mouseenter="slashSelectedIndex = index"
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
        :placeholder="activeSlashCommand?.placeholder || promptPlaceholder"
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
          <DropdownMenuRoot>
            <DropdownMenuTrigger as-child>
              <button type="button" class="ai-chat-selector ai-chat-selector--primary">
                <span>{{ modeLabel }}</span
                ><ChevronDown :size="13" />
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
                  <span class="ai-chat-menu__item-copy"
                    ><strong>{{ option.label }}</strong
                    ><small>{{ option.description }}</small></span
                  >
                  <Check v-if="mode === option.value" :size="15" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>

          <DropdownMenuRoot>
            <DropdownMenuTrigger as-child>
              <button type="button" class="ai-chat-selector">
                <span>{{ providerLabel }}</span
                ><ChevronDown :size="13" />
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
                  <span class="ai-chat-menu__item-copy"
                    ><strong>{{ option.label }}</strong
                    ><small>{{ option.description }}</small></span
                  >
                  <Check v-if="settings.provider === option.value" :size="15" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>

          <DropdownMenuRoot>
            <DropdownMenuTrigger as-child>
              <button type="button" class="ai-chat-selector ai-chat-selector--model">
                <span>{{ settings.model || '选择模型' }}</span
                ><ChevronDown :size="13" />
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
                  <span class="ai-chat-menu__item-copy"
                    ><strong>{{ model }}</strong></span
                  >
                  <Check v-if="settings.model === model" :size="15" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>

          <DropdownMenuRoot v-if="providerCapabilities.reasoningEffort">
            <DropdownMenuTrigger as-child>
              <button type="button" class="ai-chat-selector">
                <span>{{ reasoningLabel }}</span
                ><ChevronDown :size="13" />
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
                  <span class="ai-chat-menu__item-copy"
                    ><strong>{{ option.label }}</strong
                    ><small>{{ option.description }}</small></span
                  >
                  <Check v-if="settings.reasoningEffort === option.value" :size="15" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
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
        <span v-if="activeSlashCommand" class="ai-chat-composer__command"
          >/{{ activeSlashCommand.name }} · {{ activeSlashCommand.label }}</span
        >
        <span><Database :size="13" />已装载当前页面与 {{ knowledgeSourceCount }} 篇知识库资料</span>
      </p>
    </div>
  </form>
</template>
