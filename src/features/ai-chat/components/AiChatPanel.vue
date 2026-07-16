<script setup lang="ts">
import {
  Activity,
  Bot,
  BookOpen,
  Check,
  CircleCheck,
  CircleX,
  ChevronDown,
  ChevronRight,
  Database,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  LoaderCircle,
  ListChecks,
  MessageCircleQuestion,
  Copy,
  GitFork,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  RotateCcw,
  SearchCheck,
  Send,
  SlidersHorizontal,
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
import { UNGROUPED_AGENT_PROJECT_ID, type AgentProject } from '@/models/aiChatHistory'
import { resolveProviderCapabilities } from '@/models/providerCapabilities'
import type { AgentRuntimeViewState, AgentTimelineEvent } from '@/models/agentRuntime'
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
  projectId: string
  title: string
  updatedAt: number
  messageCount: number
  provider: string
  model: string
  pinnedAt: number | null
}

type BrowserPointerEvent = InstanceType<typeof globalThis.PointerEvent>
type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>
type BrowserTextAreaElement = InstanceType<typeof globalThis.HTMLTextAreaElement>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>
type BrowserEvent = InstanceType<typeof globalThis.Event>
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
    projects?: AgentProject[]
    currentProjectId?: string
    workspaceOptions?: Array<{ label: string; value: string }>
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
  'select-project': [projectId: string]
  'create-project': [input: { name: string; workspaceRootIds: string[] }]
  'new-task': [projectId: string | null]
  'pin-project': [projectId: string]
  'pin-history': [historyId: string]
  'rename-project': [projectId: string, name: string]
  'update-workspace': [projectId: string, rootIds: string[]]
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
const HISTORY_COLLAPSED_STORAGE_KEY = 'my-notebook:agent-history-collapsed'
const panelElement = ref<BrowserHTMLElement | null>(null)
const composerElement = ref<BrowserTextAreaElement | null>(null)
const newProjectNameElement = ref<BrowserInputElement | null>(null)
const messagesElement = ref<BrowserHTMLElement | null>(null)
const historyCollapsed = ref(readHistoryCollapsed())
const showWorkspaceSettings = ref(false)
const showProjectCreator = ref(false)
const newProjectName = ref('')
const newProjectWorkspaceRootIds = ref<string[]>([])
const collapsedProjectIds = ref<Set<string>>(new Set())
const runtimeClock = ref(Date.now())
const slashSelectedIndex = ref(0)
const slashMenuDismissed = ref(false)
const floatingPosition = ref<{ x: number; y: number } | null>(null)
const floatingSize = ref<{ width: number; height: number } | null>(null)
let floatingDragState: FloatingDragState | null = null
let floatingResizeState: FloatingResizeState | null = null
let shouldKeepMessagesAtBottom = true
let runtimeClockTimer: ReturnType<typeof globalThis.setInterval> | null = null

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

function openProjectCreator(): void {
  showProjectCreator.value = true
  showWorkspaceSettings.value = false
  newProjectName.value = ''
  newProjectWorkspaceRootIds.value = []
  void nextTick(() => newProjectNameElement.value?.focus())
}

function closeProjectCreator(): void {
  showProjectCreator.value = false
  newProjectName.value = ''
  newProjectWorkspaceRootIds.value = []
}

function submitProject(): void {
  const selectedWorkspaceName =
    newProjectWorkspaceRootIds.value.length === 1
      ? props.workspaceOptions.find(
          (option) => option.value === newProjectWorkspaceRootIds.value[0],
        )?.label
      : ''
  const name =
    newProjectName.value.trim() || selectedWorkspaceName || `新项目 ${props.projects.length + 1}`
  emit('create-project', {
    name,
    workspaceRootIds: [...newProjectWorkspaceRootIds.value],
  })
  closeProjectCreator()
}

function toggleNewProjectWorkspaceRoot(rootId: string, event: BrowserEvent): void {
  const checked = (event.target as BrowserInputElement).checked
  newProjectWorkspaceRootIds.value = checked
    ? [...new Set([...newProjectWorkspaceRootIds.value, rootId])]
    : newProjectWorkspaceRootIds.value.filter((id) => id !== rootId)
  if (checked && !newProjectName.value.trim()) {
    newProjectName.value = props.workspaceOptions.find((option) => option.value === rootId)?.label ?? ''
  }
}

function toggleProjectExpanded(projectId: string): void {
  const next = new Set(collapsedProjectIds.value)
  if (next.has(projectId)) next.delete(projectId)
  else next.add(projectId)
  collapsedProjectIds.value = next
}

function selectProject(projectId: string): void {
  collapsedProjectIds.value.delete(projectId)
  collapsedProjectIds.value = new Set(collapsedProjectIds.value)
  emit('select-project', projectId)
}

function startTask(projectId: string | null): void {
  if (projectId) {
    collapsedProjectIds.value.delete(projectId)
    collapsedProjectIds.value = new Set(collapsedProjectIds.value)
  }
  emit('new-task', projectId)
}

function openProjectSettings(projectId: string): void {
  if (props.currentProjectId !== projectId) emit('select-project', projectId)
  showWorkspaceSettings.value =
    props.currentProjectId === projectId ? !showWorkspaceSettings.value : true
  showProjectCreator.value = false
}

function updateProjectName(event: BrowserEvent): void {
  const name = (event.target as BrowserInputElement).value.trim()
  if (props.currentProjectId && name) emit('rename-project', props.currentProjectId, name)
}

function toggleWorkspaceRoot(rootId: string, checked: boolean): void {
  if (!props.currentProjectId) return
  const next = checked
    ? [...new Set([...props.currentWorkspaceRootIds, rootId])]
    : props.currentWorkspaceRootIds.filter((id) => id !== rootId)
  emit('update-workspace', props.currentProjectId, next)
}

function projectHistory(projectId: string): AiChatHistoryItem[] {
  return props.chatHistory.filter((item) => item.projectId === projectId)
}

const ungroupedHistory = computed(() =>
  props.chatHistory.filter((item) => item.projectId === UNGROUPED_AGENT_PROJECT_ID),
)

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
const runtimeTimelineEvents = computed<AgentTimelineEvent[]>(() => {
  if (props.runtimeState.timelineEvents?.length) return props.runtimeState.timelineEvents
  return props.runtimeState.toolCalls.map((call) => ({
    id: `tool:${call.id}`,
    kind: 'tool',
    status:
      call.status === 'running' ? 'running' : call.status === 'completed' ? 'completed' : 'failed',
    detail: summarizeToolResult(call),
    occurredAt: call.startedAt,
    completedAt: call.completedAt,
    toolCallId: call.id,
  }))
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
    submit_document_edits: '提交多文档修改提案',
  }
  return labels[toolName] ?? toolName
}

type RuntimeToolCall = AgentRuntimeViewState['toolCalls'][number]

function getTimelineTool(event: AgentTimelineEvent): RuntimeToolCall | null {
  if (!event.toolCallId) return null
  return props.runtimeState.toolCalls.find((call) => call.id === event.toolCallId) ?? null
}

function getTimelineStepTitle(event: AgentTimelineEvent): string {
  if (event.kind === 'retry') return '正在重试'
  if (event.kind === 'step_started') return `第 ${event.stepNumber ?? '?'} 轮判断`
  if (event.kind === 'step_completed') return `第 ${event.stepNumber ?? '?'} 轮完成`
  return '运行状态'
}

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

watch(historyCollapsed, (collapsed) => {
  try {
    globalThis.localStorage?.setItem(HISTORY_COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {
    // Storage is optional in embedded/webview privacy modes.
  }
})

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
        <button
          v-if="workspace || docked"
          type="button"
          class="ai-chat-popover__icon-button"
          :aria-label="historyCollapsed ? '展开对话历史' : '折叠对话历史'"
          :title="historyCollapsed ? '展开对话历史' : '折叠对话历史'"
          @click="toggleHistoryCollapsed"
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
      class="ai-chat-popover__body"
      :class="{ 'ai-chat-popover__body--history-collapsed': historyCollapsed }"
    >
      <aside
        v-if="workspace || docked"
        class="ai-chat-history"
        :class="{ 'ai-chat-history--collapsed': historyCollapsed }"
        aria-label="Agent 对话历史"
      >
        <div class="ai-chat-history__header">
          <span v-if="!historyCollapsed">项目</span>
          <button
            type="button"
            :aria-label="historyCollapsed ? '展开对话历史' : '折叠对话历史'"
            @click="toggleHistoryCollapsed"
          >
            <PanelLeftOpen v-if="historyCollapsed" :size="15" />
            <PanelLeftClose v-else :size="15" />
          </button>
        </div>
        <button
          type="button"
          class="ai-chat-history__create-project"
          aria-label="新建 Agent 项目"
          :title="historyCollapsed ? '新建项目' : undefined"
          @click="openProjectCreator"
        >
          <FolderPlus :size="15" />
          <span v-if="!historyCollapsed">新建项目</span>
        </button>
        <button
          type="button"
          class="ai-chat-history__new"
          aria-label="新建未分组任务"
          :title="historyCollapsed ? '新建未分组任务' : undefined"
          @click="startTask(null)"
        >
          <FilePlus2 :size="15" />
          <span v-if="!historyCollapsed">新建任务</span>
          <small v-if="!historyCollapsed">未分组</small>
        </button>
        <div v-if="!historyCollapsed" class="ai-chat-project-list" role="list">
          <section
            v-if="ungroupedHistory.length > 0 || currentProjectId === UNGROUPED_AGENT_PROJECT_ID"
            class="ai-chat-project ai-chat-project--ungrouped"
            :class="{ 'is-active': currentProjectId === UNGROUPED_AGENT_PROJECT_ID }"
            role="listitem"
          >
            <div class="ai-chat-project__row ai-chat-project__row--ungrouped">
              <span class="ai-chat-project__ungrouped-spacer" aria-hidden="true"></span>
              <button
                type="button"
                class="ai-chat-project__select"
                :aria-current="currentProjectId === UNGROUPED_AGENT_PROJECT_ID ? 'true' : undefined"
                @click="startTask(null)"
              >
                <FileText :size="15" />
                <span>未分组</span>
              </button>
              <button
                type="button"
                class="ai-chat-project__action"
                aria-label="新建未分组任务"
                @click="startTask(null)"
              >
                <FilePlus2 :size="13" />
              </button>
            </div>
            <div class="ai-chat-project__conversations" role="list">
              <article
                v-for="historyItem in ungroupedHistory"
                :key="historyItem.id"
                class="ai-chat-history__item"
                :class="{ 'is-active': currentHistoryId === historyItem.id }"
                role="listitem"
              >
                <button
                  type="button"
                  class="ai-chat-history__select"
                  :aria-current="currentHistoryId === historyItem.id ? 'true' : undefined"
                  @click="emit('select-history', historyItem.id)"
                >
                  <strong>{{ historyItem.title }}</strong>
                  <small>{{ formatHistoryTime(historyItem.updatedAt) }}</small>
                </button>
                <button
                  type="button"
                  class="ai-chat-history__pin"
                  :class="{ 'is-pinned': historyItem.pinnedAt !== null }"
                  :aria-label="`${historyItem.pinnedAt !== null ? '取消置顶' : '置顶'}对话：${historyItem.title}`"
                  @click="emit('pin-history', historyItem.id)"
                >
                  <Pin :size="12" />
                </button>
                <button
                  type="button"
                  class="ai-chat-history__delete"
                  :aria-label="`删除聊天记录：${historyItem.title}`"
                  @click="emit('delete-history', historyItem.id)"
                >
                  <Trash2 :size="12" />
                </button>
              </article>
            </div>
          </section>
          <p v-if="projects.length === 0" class="ai-chat-history__empty">暂无项目</p>
          <section
            v-for="project in projects"
            :key="project.id"
            class="ai-chat-project"
            :class="{ 'is-active': currentProjectId === project.id }"
            role="listitem"
          >
            <div class="ai-chat-project__row">
              <button
                type="button"
                class="ai-chat-project__expand"
                :aria-label="`${collapsedProjectIds.has(project.id) ? '展开' : '折叠'}项目：${project.name}`"
                @click="toggleProjectExpanded(project.id)"
              >
                <ChevronRight
                  :size="14"
                  :class="{ 'is-expanded': !collapsedProjectIds.has(project.id) }"
                />
              </button>
              <button
                type="button"
                class="ai-chat-project__select"
                :aria-current="currentProjectId === project.id ? 'true' : undefined"
                @click="selectProject(project.id)"
              >
                <FolderOpen v-if="!collapsedProjectIds.has(project.id)" :size="16" />
                <Folder v-else :size="16" />
                <span>{{ project.name }}</span>
              </button>
              <button
                type="button"
                class="ai-chat-project__action"
                :aria-label="`在项目中新建任务：${project.name}`"
                @click="startTask(project.id)"
              >
                <FilePlus2 :size="13" />
              </button>
              <button
                type="button"
                class="ai-chat-project__action"
                :class="{ 'is-pinned': project.pinnedAt !== null }"
                :aria-label="`${project.pinnedAt !== null ? '取消置顶' : '置顶'}项目：${project.name}`"
                @click="emit('pin-project', project.id)"
              >
                <Pin :size="13" />
              </button>
              <button
                type="button"
                class="ai-chat-project__action"
                :aria-pressed="currentProjectId === project.id && showWorkspaceSettings"
                :aria-label="`配置项目：${project.name}`"
                @click="openProjectSettings(project.id)"
              >
                <SlidersHorizontal :size="13" />
              </button>
            </div>
            <section
              v-if="currentProjectId === project.id && showWorkspaceSettings"
              class="ai-chat-workspace-settings"
              aria-label="项目工作区设置"
            >
              <label>
                <span>项目名称</span>
                <input :value="project.name" maxlength="80" @change="updateProjectName" />
              </label>
              <fieldset>
                <legend>允许检索的文档分组</legend>
                <label v-for="option in workspaceOptions" :key="option.value">
                  <input
                    type="checkbox"
                    :checked="currentWorkspaceRootIds.includes(option.value)"
                    @change="toggleWorkspaceRoot(option.value, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ option.label }}</span>
                </label>
              </fieldset>
              <p>默认只检索上述范围；证据不足时，Agent 可主动扩大到全库。</p>
            </section>
            <div
              v-if="!collapsedProjectIds.has(project.id)"
              class="ai-chat-project__conversations"
              role="list"
            >
              <button
                v-if="projectHistory(project.id).length === 0"
                type="button"
                class="ai-chat-project__empty-conversation"
                @click="startTask(project.id)"
              >
                <FilePlus2 :size="12" />新建任务
              </button>
              <article
                v-for="historyItem in projectHistory(project.id)"
                :key="historyItem.id"
                class="ai-chat-history__item"
                :class="{ 'is-active': currentHistoryId === historyItem.id }"
                role="listitem"
              >
                <button
                  type="button"
                  class="ai-chat-history__select"
                  :aria-current="currentHistoryId === historyItem.id ? 'true' : undefined"
                  @click="emit('select-history', historyItem.id)"
                >
                  <strong>{{ historyItem.title }}</strong>
                  <small>{{ formatHistoryTime(historyItem.updatedAt) }}</small>
                </button>
                <button
                  type="button"
                  class="ai-chat-history__pin"
                  :class="{ 'is-pinned': historyItem.pinnedAt !== null }"
                  :aria-label="`${historyItem.pinnedAt !== null ? '取消置顶' : '置顶'}对话：${historyItem.title}`"
                  @click="emit('pin-history', historyItem.id)"
                >
                  <Pin :size="12" />
                </button>
                <button
                  type="button"
                  class="ai-chat-history__delete"
                  :aria-label="`删除聊天记录：${historyItem.title}`"
                  @click="emit('delete-history', historyItem.id)"
                >
                  <Trash2 :size="12" />
                </button>
              </article>
            </div>
          </section>
        </div>
      </aside>

      <div class="ai-chat-popover__main">
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

              <ol
                v-if="runtimeTimelineEvents.length > 0"
                class="ai-agent-tool-list ai-agent-timeline"
              >
                <li
                  v-for="event in runtimeTimelineEvents"
                  :key="event.id"
                  :class="`ai-agent-tool-list__item--${event.status}`"
                >
                  <details
                    v-if="getTimelineTool(event)"
                    class="ai-agent-tool-step"
                    :open="getTimelineTool(event)?.status === 'failed'"
                  >
                    <summary>
                      <span class="ai-agent-tool-step__marker" aria-hidden="true">
                        <LoaderCircle
                          v-if="getTimelineTool(event)?.status === 'running'"
                          :size="13"
                          class="ai-agent-tool-list__spinner"
                        />
                        <CircleCheck
                          v-else-if="getTimelineTool(event)?.status === 'completed'"
                          :size="13"
                        />
                        <CircleX v-else :size="13" />
                      </span>
                      <span class="ai-agent-tool-step__copy">
                        <strong>{{ getToolLabel(getTimelineTool(event)?.toolName ?? '') }}</strong>
                        <small>{{
                          summarizeToolArguments(getTimelineTool(event)?.argumentsJson ?? '')
                        }}</small>
                      </span>
                      <span class="ai-agent-tool-step__status">{{
                        summarizeToolResult(getTimelineTool(event)!)
                      }}</span>
                      <time>{{
                        formatToolDuration(
                          getTimelineTool(event)?.startedAt ?? event.occurredAt,
                          getTimelineTool(event)?.completedAt ?? event.completedAt,
                        )
                      }}</time>
                      <ChevronDown
                        :size="13"
                        class="ai-agent-tool-step__chevron"
                        aria-hidden="true"
                      />
                    </summary>
                    <div class="ai-agent-tool-step__details">
                      <span>工具</span>
                      <code>{{ getTimelineTool(event)?.toolName }}</code>
                      <template
                        v-if="formatToolDetail(getTimelineTool(event)?.argumentsJson ?? null)"
                      >
                        <span>输入</span>
                        <pre>{{
                          formatToolDetail(getTimelineTool(event)?.argumentsJson ?? null)
                        }}</pre>
                      </template>
                      <template v-if="getTimelineTool(event)?.error">
                        <span>错误</span>
                        <pre class="ai-agent-tool-list__error">{{
                          getTimelineTool(event)?.error
                        }}</pre>
                      </template>
                      <template
                        v-else-if="formatToolDetail(getTimelineTool(event)?.resultJson ?? null)"
                      >
                        <span>结果</span>
                        <pre>{{
                          formatToolDetail(getTimelineTool(event)?.resultJson ?? null)
                        }}</pre>
                      </template>
                    </div>
                  </details>
                  <p
                    v-if="getTimelineTool(event) && getToolResultPreview(getTimelineTool(event)!)"
                    class="ai-agent-tool-step__preview"
                  >
                    {{ getToolResultPreview(getTimelineTool(event)!) }}
                  </p>
                  <div v-if="!getTimelineTool(event)" class="ai-agent-timeline__step">
                    <span class="ai-agent-tool-step__marker" aria-hidden="true">
                      <LoaderCircle
                        v-if="event.status === 'running'"
                        :size="13"
                        class="ai-agent-tool-list__spinner"
                      />
                      <CircleCheck v-else-if="event.status === 'completed'" :size="13" />
                      <CircleX v-else :size="13" />
                    </span>
                    <span>
                      <strong>{{ getTimelineStepTitle(event) }}</strong>
                      <small>{{ event.detail }}</small>
                    </span>
                  </div>
                </li>
              </ol>

              <div class="ai-agent-loop__phase">
                <span
                  v-if="
                    runtimeState.status === 'running' ||
                    runtimeState.status === 'waiting_authorizer'
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
              <span>{{
                chatMessage.reasoningContent?.trim() ? '等待正文输出' : '等待模型响应'
              }}</span>
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
              <button
                type="button"
                :disabled="isRunning"
                @click="emit('fork-message', chatMessage.id)"
              >
                <GitFork :size="13" />分支
              </button>
              <button
                type="button"
                :disabled="isRunning"
                @click="emit('edit-message', chatMessage.id)"
              >
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
                        :class="{
                          'ai-chat-menu__item--active': settings.provider === option.value,
                        }"
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
                ><Database :size="13" />已装载当前页面与
                {{ knowledgeSourceCount }} 篇知识库资料</span
              >
            </p>
          </div>
        </form>
      </div>
    </div>
    <div
      v-if="showProjectCreator"
      class="ai-chat-project-dialog-backdrop"
      @click.self="closeProjectCreator"
      @keydown.esc.stop="closeProjectCreator"
    >
      <form
        class="ai-chat-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-chat-project-dialog-title"
        @submit.prevent="submitProject"
      >
        <header>
          <div>
            <strong id="ai-chat-project-dialog-title">新建项目</strong>
            <span>项目会集中管理一组对话和默认文档工作区。</span>
          </div>
          <button type="button" aria-label="关闭新建项目" @click="closeProjectCreator">
            <X :size="16" />
          </button>
        </header>
        <label class="ai-chat-project-dialog__name">
          <span>项目名称</span>
          <input
            ref="newProjectNameElement"
            v-model="newProjectName"
            maxlength="80"
            placeholder="例如：StudioSite"
          />
          <small>不填写时会使用所选工作区名称或自动生成名称。</small>
        </label>
        <fieldset>
          <legend>默认工作区 <small>可多选，也可以稍后配置</small></legend>
          <p v-if="workspaceOptions.length === 0" class="ai-chat-project-dialog__empty">
            暂无文档分组，将创建一个空项目。
          </p>
          <label
            v-for="option in workspaceOptions"
            :key="option.value"
            class="ai-chat-project-dialog__workspace"
          >
            <input
              type="checkbox"
              :checked="newProjectWorkspaceRootIds.includes(option.value)"
              @change="toggleNewProjectWorkspaceRoot(option.value, $event)"
            />
            <Folder :size="16" />
            <span>{{ option.label }}</span>
            <Check
              v-if="newProjectWorkspaceRootIds.includes(option.value)"
              :size="14"
              aria-hidden="true"
            />
          </label>
        </fieldset>
        <p class="ai-chat-project-dialog__scope-note">
          Agent 默认在这些分组内检索；现有证据不足时仍可明确扩展到全库。
        </p>
        <footer>
          <button type="button" @click="closeProjectCreator">取消</button>
          <button type="submit"><FolderPlus :size="14" />创建项目</button>
        </footer>
      </form>
    </div>
  </section>
</template>
