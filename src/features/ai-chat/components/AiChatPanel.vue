<script setup lang="ts">
import {
  Activity,
  Bot,
  BookOpen,
  Check,
  CircleCheck,
  CircleX,
  ChevronDown,
  Database,
  FilePlus2,
  FileText,
  History,
  LoaderCircle,
  ListChecks,
  MessageCircleQuestion,
  Copy,
  GitFork,
  Maximize2,
  Minimize2,
  Pencil,
  RotateCcw,
  SearchCheck,
  Send,
  Square,
  Sparkles,
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import type { AiProvider, AiReasoningEffort, AiSettings } from '@/models/ai'
import { resolveProviderCapabilities } from '@/models/providerCapabilities'
import type { AgentRuntimeViewState } from '@/models/agentRuntime'
import {
  filterAgentSlashCommands,
  resolveAgentSlashCommand,
  type AgentSlashCommand,
} from '@/models/agentSlashCommand'
import type { KnowledgeSource } from '@/models/knowledgeRetrieval'
import { parseInternalDocumentHref } from '@/models/documentLink'
import type { AiChatMode, AiChatRole, AiChatStatus, AiSelectorOption } from '@/models/aiChatMode'

interface AiChatMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  reasoningContent?: string
  sources?: KnowledgeSource[]
  status: AiChatStatus
}

interface AiChatHistoryItem {
  id: string
  title: string
  updatedAt: number
  messageCount: number
  provider: string
  model: string
}

type BrowserPointerEvent = InstanceType<typeof globalThis.PointerEvent>
type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>
type BrowserTextAreaElement = InstanceType<typeof globalThis.HTMLTextAreaElement>
type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>

interface FloatingDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  width: number
  height: number
}

type ResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface FloatingResizeState {
  pointerId: number
  direction: ResizeDirection
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  startWidth: number
  startHeight: number
}

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
    messages: AiChatMessage[]
    chatHistory?: AiChatHistoryItem[]
    currentDocumentTitle: string
    knowledgeSourceCount: number
    prompt: string
    promptPlaceholder: string
    error: string
    isRunning: boolean
    agentStep?: string
    runtimeState: AgentRuntimeViewState
    renderMarkdownMessage: (markdown: string) => string
  }>(),
  {
    chatHistory: () => [],
    agentStep: '',
    docked: false,
  },
)

const providerCapabilities = computed(() =>
  resolveProviderCapabilities(props.settings.provider, props.settings.model),
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
  'select-history': [historyId: string]
  'delete-history': [historyId: string]
  close: []
  run: []
  stop: []
  clear: []
  insert: [content: string]
}>()

const resizeDirections: ResizeDirection[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
const quickPrompts = [
  { label: '提炼要点', prompt: '请提炼当前页面的核心观点，并用 3–5 条要点说明。' },
  { label: '查找关联资料', prompt: '请从知识库中找出与当前页面最相关的资料，并说明关联原因。' },
  { label: '提取行动项', prompt: '请从当前页面提取待办、决策和后续行动项。' },
  { label: '整理为提纲', prompt: '请将当前页面整理成层级清晰的 Markdown 提纲。' },
]
const panelElement = ref<BrowserHTMLElement | null>(null)
const composerElement = ref<BrowserTextAreaElement | null>(null)
const messagesElement = ref<BrowserHTMLElement | null>(null)
const runtimeClock = ref(Date.now())
const slashSelectedIndex = ref(0)
const slashMenuDismissed = ref(false)
const floatingPosition = ref<{ x: number; y: number } | null>(null)
const floatingSize = ref<{ width: number; height: number } | null>(null)
let floatingDragState: FloatingDragState | null = null
let floatingResizeState: FloatingResizeState | null = null
let shouldKeepMessagesAtBottom = true
let runtimeClockTimer: ReturnType<typeof globalThis.setInterval> | null = null

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
const slashCommands = computed(() =>
  slashMenuDismissed.value ? [] : filterAgentSlashCommands(props.prompt),
)
const activeSlashCommand = computed(() => resolveAgentSlashCommand(props.prompt)?.command ?? null)

const runtimeMeta = computed(() => {
  const items = [runtimeStatusLabel(props.runtimeState.status)]
  if (props.runtimeState.startedAt) {
    items.push(
      formatDuration(
        props.runtimeState.startedAt,
        props.runtimeState.completedAt ?? runtimeClock.value,
      ),
    )
  }
  if (props.runtimeState.rounds > 0) items.push(`${props.runtimeState.rounds} 轮`)
  if (props.runtimeState.toolCalls.length > 0) {
    items.push(`${props.runtimeState.toolCalls.length} 次工具调用`)
  }
  return items.join(' · ')
})

const floatingWindowStyle = computed(() => {
  if (props.workspace || props.docked) return undefined

  return {
    ...(floatingPosition.value
      ? {
          left: `${floatingPosition.value.x}px`,
          top: `${floatingPosition.value.y}px`,
          right: 'auto',
          bottom: 'auto',
        }
      : {}),
    ...(floatingSize.value
      ? {
          width: `${floatingSize.value.width}px`,
          height: `${floatingSize.value.height}px`,
        }
      : {}),
  }
})

function updatePrompt(event: InstanceType<typeof globalThis.Event>): void {
  const target = event.target as { value?: string } | null
  emit('update:prompt', target?.value ?? '')
  slashMenuDismissed.value = false
  slashSelectedIndex.value = 0
  resizeComposer(target as BrowserTextAreaElement | null)
}

function resizeComposer(target: BrowserTextAreaElement | null): void {
  if (!target) return
  target.style.height = 'auto'
  target.style.height = `${Math.min(target.scrollHeight, 220)}px`
}

function handleComposerKeydown(event: BrowserKeyboardEvent): void {
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

function useQuickPrompt(prompt: string): void {
  emit('select-mode', 'ask')
  emit('update:prompt', prompt)
}

function formatHistoryTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time

  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function runtimeStatusLabel(status: AgentRuntimeViewState['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'waiting_authorizer') return '等待授权人'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已停止'
  return '待命'
}

function formatDuration(startedAt: number, completedAt: number): string {
  const duration = Math.max(0, completedAt - startedAt)
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.floor((duration % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

function formatToolDuration(startedAt: number, completedAt: number | null): string {
  return formatDuration(startedAt, completedAt ?? runtimeClock.value)
}

function getToolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    get_current_document: '读取当前页面',
    get_selected_blocks: '读取选中块',
    get_document_outline: '读取页面大纲',
    search_documents: '搜索知识库',
    list_document_groups: '查找文档分组',
    read_document: '读取知识文档',
    find_blocks_by_regex: '定位内容块',
    read_skill_file: '读取技能资料',
    request_authorizer_input: '询问授权人',
    execute_shell: '执行只读命令',
    inspect_environment_paths: '检查环境路径',
    discover_local_tools: '发现本机工具',
    get_system_info: '读取系统信息',
    create_automation_draft: '创建自动化草稿',
    create_skill_draft: '创建 Skill 草稿',
    replace_text_by_regex: '提交文本替换提案',
    replace_block: '提交块修改提案',
    insert_blocks: '提交内容插入提案',
    create_document: '提交新文档提案',
    create_group: '提交新分组提案',
    propose_document_patches: '提交复杂修改提案',
  }
  return labels[toolName] ?? toolName
}

type RuntimeToolCall = AgentRuntimeViewState['toolCalls'][number]

function parseToolPayload(value: string | null): unknown {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed) && Array.isArray(parsed.content)) {
      const textBlocks = parsed.content
        .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
      if (textBlocks.length === 1) {
        try {
          return JSON.parse(textBlocks[0] ?? '') as unknown
        } catch {
          return textBlocks[0]
        }
      }
      if (textBlocks.length > 1) return textBlocks
    }
    return parsed
  } catch {
    return value
  }
}

function formatToolDetail(value: string | null, maxLength = 8_000): string {
  const payload = parseToolPayload(value)
  if (payload === null) return ''
  const formatted = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return formatted.length > maxLength ? `${formatted.slice(0, maxLength)}\n… 已截断` : formatted
}

function summarizeToolArguments(value: string): string {
  const payload = parseToolPayload(value)
  if (!isRecord(payload)) return ''
  const preferredKeys = ['query', 'documentId', 'uri', 'url', 'command', 'pattern', 'name']
  const key = preferredKeys.find((candidate) => payload[candidate] !== undefined)
  if (!key) {
    const count = Object.keys(payload).length
    return count > 0 ? `${count} 个参数` : '无参数'
  }
  const rawValue = payload[key]
  const text = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue)
  return `${key}: ${text.length > 88 ? `${text.slice(0, 88)}…` : text}`
}

function summarizeToolResult(toolCall: RuntimeToolCall): string {
  if (toolCall.status === 'running') return '执行中'
  if (toolCall.error) {
    return toolCall.error.length > 100 ? `${toolCall.error.slice(0, 100)}…` : toolCall.error
  }
  const payload = parseToolPayload(toolCall.resultJson)
  if (Array.isArray(payload)) return `完成 · 返回 ${payload.length} 项`
  if (isRecord(payload)) {
    const collection = ['results', 'items', 'documents', 'tools', 'resources'].find((key) =>
      Array.isArray(payload[key]),
    )
    if (collection) return `完成 · 返回 ${(payload[collection] as unknown[]).length} 项`
    if (payload.ok === false) return '完成 · 工具返回未成功状态'
  }
  return '已完成'
}

function getToolResultPreview(toolCall: RuntimeToolCall): string {
  if (toolCall.status !== 'completed') return ''
  const payload = parseToolPayload(toolCall.resultJson)
  const preview = extractToolPreview(payload)
  if (!preview) return ''
  const normalized = preview.replace(/\s+/g, ' ').trim()
  return normalized.length > 320 ? `${normalized.slice(0, 320)}…` : normalized
}

function extractToolPreview(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const labels = value
      .slice(0, 4)
      .map((item) => extractItemLabel(item))
      .filter(Boolean)
    return labels.join(' · ')
  }
  if (!isRecord(value)) return ''

  for (const key of ['results', 'items', 'documents', 'groups', 'tools', 'resources']) {
    if (Array.isArray(value[key])) return extractToolPreview(value[key])
  }
  for (const key of ['stdout', 'output', 'text', 'content', 'message', 'title', 'name']) {
    if (typeof value[key] === 'string') return value[key]
  }
  if (value.proposalCaptured === true) return '修改提案已进入确认队列'
  return ''
}

function extractItemLabel(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  for (const key of ['title', 'documentTitle', 'name', 'label', 'path', 'contentSnippet']) {
    if (typeof value[key] === 'string') return value[key]
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAssistantMessage(chatMessage: AiChatMessage): boolean {
  return chatMessage.role === 'assistant'
}

function isRuntimeHostMessage(chatMessage: AiChatMessage): boolean {
  return showRuntimeState.value && chatMessage.id === runtimeMessageId.value
}

function hasMessageOutput(chatMessage: AiChatMessage): boolean {
  return Boolean(chatMessage.content.trim() || chatMessage.reasoningContent?.trim())
}

function showMessageActions(chatMessage: AiChatMessage): boolean {
  if (chatMessage.status === 'streaming') return false
  return hasMessageOutput(chatMessage)
}

function startWindowDrag(event: BrowserPointerEvent): void {
  if (props.workspace || props.docked || event.button !== 0) return
  const target = event.target
  if (target instanceof globalThis.Element && target.closest('button, input, textarea, select')) {
    return
  }

  const rect = panelElement.value?.getBoundingClientRect()
  if (!rect) return

  event.preventDefault()
  floatingPosition.value = {
    x: rect.left,
    y: rect.top,
  }
  floatingDragState = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: rect.left,
    startY: rect.top,
    width: rect.width,
    height: rect.height,
  }
  ;(event.currentTarget as BrowserHTMLElement | null)?.setPointerCapture?.(event.pointerId)
  globalThis.window.addEventListener('pointermove', dragFloatingWindow)
  globalThis.window.addEventListener('pointerup', stopWindowDrag)
}

function dragFloatingWindow(event: BrowserPointerEvent): void {
  if (!floatingDragState || event.pointerId !== floatingDragState.pointerId) return

  const nextX = floatingDragState.startX + event.clientX - floatingDragState.startClientX
  const nextY = floatingDragState.startY + event.clientY - floatingDragState.startClientY

  floatingPosition.value = {
    x: clamp(nextX, 8, Math.max(8, globalThis.window.innerWidth - floatingDragState.width - 8)),
    y: clamp(nextY, 8, Math.max(8, globalThis.window.innerHeight - floatingDragState.height - 8)),
  }
}

function stopWindowDrag(): void {
  floatingDragState = null
  globalThis.window.removeEventListener('pointermove', dragFloatingWindow)
  globalThis.window.removeEventListener('pointerup', stopWindowDrag)
}

function startWindowResize(direction: ResizeDirection, event: BrowserPointerEvent): void {
  if (props.workspace || props.docked || event.button !== 0) return
  const rect = panelElement.value?.getBoundingClientRect()
  if (!rect) return

  event.preventDefault()
  event.stopPropagation()
  floatingPosition.value = {
    x: rect.left,
    y: rect.top,
  }
  floatingSize.value = {
    width: rect.width,
    height: rect.height,
  }
  floatingResizeState = {
    pointerId: event.pointerId,
    direction,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: rect.left,
    startY: rect.top,
    startWidth: rect.width,
    startHeight: rect.height,
  }
  ;(event.currentTarget as BrowserHTMLElement | null)?.setPointerCapture?.(event.pointerId)
  globalThis.window.addEventListener('pointermove', resizeFloatingWindow)
  globalThis.window.addEventListener('pointerup', stopWindowResize)
}

function resizeFloatingWindow(event: BrowserPointerEvent): void {
  if (!floatingResizeState || event.pointerId !== floatingResizeState.pointerId) return

  const deltaX = event.clientX - floatingResizeState.startClientX
  const deltaY = event.clientY - floatingResizeState.startClientY
  const minWidth = Math.min(340, Math.max(280, globalThis.window.innerWidth - 32))
  const minHeight = Math.min(360, Math.max(260, globalThis.window.innerHeight - 32))
  const maxWidth = Math.max(minWidth, globalThis.window.innerWidth - 16)
  const maxHeight = Math.max(minHeight, globalThis.window.innerHeight - 16)
  let nextX = floatingResizeState.startX
  let nextY = floatingResizeState.startY
  let nextWidth = floatingResizeState.startWidth
  let nextHeight = floatingResizeState.startHeight

  if (floatingResizeState.direction.includes('e')) {
    nextWidth = floatingResizeState.startWidth + deltaX
  }
  if (floatingResizeState.direction.includes('s')) {
    nextHeight = floatingResizeState.startHeight + deltaY
  }
  if (floatingResizeState.direction.includes('w')) {
    nextWidth = floatingResizeState.startWidth - deltaX
    nextX = floatingResizeState.startX + deltaX
  }
  if (floatingResizeState.direction.includes('n')) {
    nextHeight = floatingResizeState.startHeight - deltaY
    nextY = floatingResizeState.startY + deltaY
  }

  nextWidth = clamp(nextWidth, minWidth, maxWidth)
  nextHeight = clamp(nextHeight, minHeight, maxHeight)

  if (floatingResizeState.direction.includes('w')) {
    nextX = floatingResizeState.startX + floatingResizeState.startWidth - nextWidth
  }
  if (floatingResizeState.direction.includes('n')) {
    nextY = floatingResizeState.startY + floatingResizeState.startHeight - nextHeight
  }

  nextX = clamp(nextX, 8, Math.max(8, globalThis.window.innerWidth - nextWidth - 8))
  nextY = clamp(nextY, 8, Math.max(8, globalThis.window.innerHeight - nextHeight - 8))

  floatingPosition.value = { x: nextX, y: nextY }
  floatingSize.value = { width: nextWidth, height: nextHeight }
}

function stopWindowResize(): void {
  floatingResizeState = null
  globalThis.window.removeEventListener('pointermove', resizeFloatingWindow)
  globalThis.window.removeEventListener('pointerup', stopWindowResize)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
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
}

function scrollMessagesToLatest(): void {
  if (!shouldKeepMessagesAtBottom) return
  void nextTick(() => {
    const element = messagesElement.value
    if (element) element.scrollTop = element.scrollHeight
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
    if (isRunning) shouldKeepMessagesAtBottom = true
    if (runtimeClockTimer) globalThis.clearInterval(runtimeClockTimer)
    runtimeClock.value = Date.now()
    runtimeClockTimer = isRunning
      ? globalThis.setInterval(() => {
          runtimeClock.value = Date.now()
        }, 250)
      : null
    scrollMessagesToLatest()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  stopWindowDrag()
  stopWindowResize()
  if (runtimeClockTimer) globalThis.clearInterval(runtimeClockTimer)
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
    <header
      class="ai-chat-popover__header"
      :class="{ 'ai-chat-popover__header--draggable': !workspace && !docked }"
      @pointerdown="startWindowDrag"
    >
      <div class="ai-chat-popover__heading">
        <strong>知识库 Agent</strong>
        <span>{{ providerLabel }} · {{ settings.model || '未选择模型' }}</span>
      </div>
      <div class="ai-chat-popover__window-actions">
        <DropdownMenuRoot>
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
                  <small>
                    {{ formatHistoryTime(historyItem.updatedAt) }} ·
                    {{ historyItem.messageCount }} 条 · {{ historyItem.model }}
                  </small>
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
        <section
          v-if="isRuntimeHostMessage(chatMessage)"
          class="ai-agent-loop"
          :class="`ai-agent-loop--${runtimeState.status}`"
          role="status"
          aria-label="Agent 运行轨迹"
        >
          <header class="ai-agent-loop__header">
            <span class="ai-agent-loop__identity"><Activity :size="14" /> Agent loop</span>
            <small>{{ runtimeMeta }} · {{ providerLabel }} / {{ settings.model }}</small>
            <button
              v-if="isRunning"
              type="button"
              aria-label="停止 Agent"
              title="停止 Agent"
              @click="emit('stop')"
            >
              <Square :size="12" fill="currentColor" />
            </button>
          </header>

          <ol v-if="runtimeState.toolCalls.length > 0" class="ai-agent-tool-list">
            <li
              v-for="toolCall in runtimeState.toolCalls"
              :key="toolCall.id"
              :class="`ai-agent-tool-list__item--${toolCall.status}`"
            >
              <details class="ai-agent-tool-step" :open="toolCall.status === 'failed'">
                <summary>
                  <span class="ai-agent-tool-step__marker" aria-hidden="true">
                    <LoaderCircle
                      v-if="toolCall.status === 'running'"
                      :size="13"
                      class="ai-agent-tool-list__spinner"
                    />
                    <CircleCheck v-else-if="toolCall.status === 'completed'" :size="13" />
                    <CircleX v-else :size="13" />
                  </span>
                  <span class="ai-agent-tool-step__copy">
                    <strong>{{ getToolLabel(toolCall.toolName) }}</strong>
                    <small>{{ summarizeToolArguments(toolCall.argumentsJson) }}</small>
                  </span>
                  <span class="ai-agent-tool-step__status">{{
                    summarizeToolResult(toolCall)
                  }}</span>
                  <time>{{ formatToolDuration(toolCall.startedAt, toolCall.completedAt) }}</time>
                  <ChevronDown :size="13" class="ai-agent-tool-step__chevron" aria-hidden="true" />
                </summary>
                <div class="ai-agent-tool-step__details">
                  <span>工具</span>
                  <code>{{ toolCall.toolName }}</code>
                  <template v-if="formatToolDetail(toolCall.argumentsJson)">
                    <span>输入</span>
                    <pre>{{ formatToolDetail(toolCall.argumentsJson) }}</pre>
                  </template>
                  <template v-if="toolCall.error">
                    <span>错误</span>
                    <pre class="ai-agent-tool-list__error">{{ toolCall.error }}</pre>
                  </template>
                  <template v-else-if="formatToolDetail(toolCall.resultJson)">
                    <span>结果</span>
                    <pre>{{ formatToolDetail(toolCall.resultJson) }}</pre>
                  </template>
                </div>
              </details>
              <p v-if="getToolResultPreview(toolCall)" class="ai-agent-tool-step__preview">
                {{ getToolResultPreview(toolCall) }}
              </p>
            </li>
          </ol>

          <div class="ai-agent-loop__phase">
            <span
              v-if="
                runtimeState.status === 'running' || runtimeState.status === 'waiting_authorizer'
              "
              class="ai-agent-runbar__pulse"
              aria-hidden="true"
            ></span>
            <CircleCheck
              v-else-if="runtimeState.status === 'completed'"
              :size="14"
              class="ai-agent-loop__success"
              aria-hidden="true"
            />
            <CircleX v-else :size="14" class="ai-agent-loop__error" aria-hidden="true" />
            <strong>{{ runtimeState.detail || agentStep || '正在分析上下文' }}</strong>
          </div>
        </section>
        <details
          v-if="chatMessage.reasoningContent?.trim()"
          class="ai-chat-message__reasoning"
          :open="chatMessage.status === 'streaming' && !chatMessage.content.trim()"
        >
          <summary>{{ chatMessage.status === 'streaming' ? '思考中' : '思考内容' }}</summary>
          <pre>{{ chatMessage.reasoningContent }}</pre>
        </details>
        <!-- renderAiMarkdown emits only allowlisted tags and escapes text, attributes and URLs. -->
        <!-- eslint-disable vue/no-v-html -->
        <div
          v-if="chatMessage.content.trim()"
          class="markdown-preview"
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
    </div>

    <p v-if="error" class="ai-chat-popover__error">{{ error }}</p>

    <form class="ai-chat-composer" @submit.prevent="emit('run')">
      <div class="ai-chat-input-shell">
        <div
          v-if="slashCommands.length"
          class="ai-slash-menu"
          role="listbox"
          aria-label="Agent 功能"
        >
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
                  <span>{{ settings.model || '选择模型' }}</span>
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
                    </span>
                    <Check v-if="settings.model === model" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot v-if="providerCapabilities.reasoningEffort">
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
            <button
              type="button"
              :disabled="messages.length === 0 && !error"
              @click="emit('clear')"
            >
              清空
            </button>
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
          <span v-if="activeSlashCommand" class="ai-chat-composer__command">
            /{{ activeSlashCommand.name }} · {{ activeSlashCommand.label }}
          </span>
          <span
            ><Database :size="13" />已装载当前页面与 {{ knowledgeSourceCount }} 篇知识库资料</span
          >
        </p>
      </div>
    </form>
  </section>
</template>
