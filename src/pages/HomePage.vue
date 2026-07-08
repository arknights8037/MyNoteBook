<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  Folder,
  FolderOpen,
  Info,
  ImagePlus,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from '@lucide/vue'
import { open, save } from '@tauri-apps/plugin-dialog'
import {
  NButton,
  NButtonGroup,
  NDrawer,
  NDrawerContent,
  NIcon,
  NInput,
  NModal,
  NTooltip,
  useDialog,
  useMessage,
} from '@/ui'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { useDocumentAutosave } from '@/composables/useDocumentAutosave'
import { ensureTopLevelBlockIds } from '@/editor/blockId'
import EditorShell from '@/editor/EditorShell.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import AiChatPanel from './AiChatPanel.vue'
import { parseEditorContentJson } from '@/editor/editorContent'
import {
  exportDocumentToHtml,
  exportDocumentToMarkdown,
  metadataFromDocument,
} from '@/editor/documentExport'
import { parseNotebookJsonDocument } from '@/editor/jsonImport'
import { parseMarkdownDocument } from '@/editor/markdownImport'
import { closeDatabase } from '@/infrastructure/database/connection'
import {
  getDefaultDataDirectory,
  migrateDataDirectory,
} from '@/infrastructure/database/dataDirectory'
import { createDocumentRepository } from '@/infrastructure/database/documentRepositoryFactory'
import {
  EMPTY_TIPTAP_DOCUMENT,
  type DocumentId,
  type DocumentKind,
  type DocumentSummary,
  type TiptapDocumentJson,
} from '@/models/document'
import {
  DEFAULT_AI_SETTINGS,
  loadAiSettings,
  saveAiSettings,
  type AiProvider,
  type AiReasoningEffort,
  type AiSettings,
} from '@/models/ai'
import type { AppError } from '@/models/result'
import {
  createDefaultAppSettings,
  loadAppSettings,
  matchesShortcut,
  saveAppSettings,
  type AppSettings,
} from '@/models/settings'
import { DocumentService } from '@/services/DocumentService'
import { runAiMarkdownCompletion } from '@/services/AiMarkdownService'
import { applyTheme, setThemePreference, subscribeToSystemTheme } from '@/services/theme'
import SidebarDocumentTree from './SidebarDocumentTree.vue'
import {
  buildSidebarDocumentForest,
  collectArticleDescendants,
  countSidebarDocumentNodes,
} from './documentTree'

interface EditorShellExpose {
  getJSON: () => TiptapDocumentJson | undefined
  getText: () => string
  insertImage: () => void
  insertAttachment: () => void
  insertMarkdown: (markdown: string) => void
}

type SidebarView = 'documents' | 'trash'
type ImportFormat = 'json' | 'markdown'

interface CreateDocumentOptions {
  parentId?: DocumentId | null
  documentKind?: DocumentKind
  content?: TiptapDocumentJson
  plainText?: string
}

interface MarkdownFileInput {
  files?: MarkdownFileList | null
  value: string
  click: () => void
}

interface MarkdownFileList {
  readonly length: number
  [index: number]: MarkdownFile
}

interface MarkdownFile {
  name: string
  text: () => Promise<string>
}

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

type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>
type BrowserDragEvent = InstanceType<typeof globalThis.DragEvent>

const INITIAL_TITLE = '未命名文档'
const LAST_DOCUMENT_STORAGE_KEY = 'my-notebook:last-document'
const INITIAL_PLAIN_TEXT = `${INITIAL_TITLE}\n现在可以输入正文、标题、列表、引用和代码块。输入 / 打开块菜单。`
const AI_MODE_OPTIONS: Array<AiSelectorOption<AiChatMode>> = [
  { value: 'ask', label: 'Ask', description: '在聊天里回答' },
  { value: 'edit', label: 'Edit', description: '把 Markdown 写入文档' },
]
const AI_PROVIDER_OPTIONS: Array<
  AiSelectorOption<AiProvider> & { endpoint: string; models: string[] }
> = [
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'Chat Completions',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini', 'gpt-5'],
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude Messages',
    endpoint: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    description: 'OpenAI-compatible',
    endpoint: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    value: 'qwen',
    label: '通义千问',
    description: 'DashScope 兼容模式',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-plus', 'qwen3-max'],
  },
  {
    value: 'openai-compatible',
    label: '兼容接口',
    description: '自定义 OpenAI-compatible',
    endpoint: DEFAULT_AI_SETTINGS.endpoint,
    models: [DEFAULT_AI_SETTINGS.model],
  },
]
const AI_REASONING_OPTIONS: Array<AiSelectorOption<AiReasoningEffort>> = [
  { value: 'auto', label: '自动', description: '按模型默认策略' },
  { value: 'low', label: '轻量思考', description: '更快响应' },
  { value: 'medium', label: '标准思考', description: '平衡质量与速度' },
  { value: 'high', label: '深度思考', description: '更适合复杂整理' },
]

const editorContent = ref<TiptapDocumentJson>(createInitialDocumentContent(INITIAL_TITLE))
const plainText = ref(INITIAL_PLAIN_TEXT)
const documentTitle = ref(INITIAL_TITLE)
const currentDocumentId = ref<DocumentId>(createDocumentId())
const editorShell = ref<EditorShellExpose | null>(null)
const importFileInput = ref<MarkdownFileInput | null>(null)
const documentService = shallowRef<DocumentService | null>(null)
const documents = ref<DocumentSummary[]>([])
const deletedDocuments = ref<DocumentSummary[]>([])
const sidebarView = ref<SidebarView>('documents')
const selectedGroupId = ref<DocumentId | null>(null)
const collapsedGroupIds = ref<Set<DocumentId>>(new Set())
const collapsedDocumentIds = ref<Set<DocumentId>>(new Set())
const isLoadingDocument = ref(true)
const isBusy = ref(false)
const loadError = ref<AppError | null>(null)
const actionError = ref<AppError | null>(null)
const renamingDocumentId = ref<DocumentId | null>(null)
const renameTitle = ref('')
const showInspector = ref(false)
const showCreateGroupModal = ref(false)
const showImportModal = ref(false)
const showRenameModal = ref(false)
const showPropertiesModal = ref(false)
const showSearchModal = ref(false)
const showShareModal = ref(false)
const showAiChat = ref(false)
const aiChatFullscreen = ref(false)
const showSettings = ref(false)
const appSettings = ref<AppSettings>(loadAppSettings())
const defaultDataDirectory = ref('')
const isChangingDataDirectory = ref(false)
const propertiesDocumentId = ref<DocumentId | null>(null)
const searchQuery = ref('')
const selectedImportFormat = ref<ImportFormat | null>(null)
const draggedArticleId = ref<DocumentId | null>(null)
const dropTargetGroupId = ref<DocumentId | null>(null)
const newGroupTitle = ref('新分组')
const propertiesDraftTags = ref('')
const propertiesDraftSourceUrl = ref('')
const propertiesDraftAuthor = ref('')
const propertiesDraftDescription = ref('')
const isSavingProperties = ref(false)
const shareHtml = ref('')
const shareMarkdown = ref('')
const isPreparingShare = ref(false)
const aiSettings = ref<AiSettings>(loadAiSettings())
const aiChatMode = ref<AiChatMode>('ask')
const aiMessages = ref<AiChatMessage[]>([])
const aiPrompt = ref('')
const aiError = ref('')
const aiIsRunning = ref(false)
let aiAbortController: InstanceType<typeof globalThis.AbortController> | null = null
const dialog = useDialog()
const message = useMessage()
let unsubscribeSystemTheme: (() => void) | null = null

const autosave = useDocumentAutosave({
  documentId: currentDocumentId,
  documentService,
  getSnapshot: () => {
    const content = ensureTopLevelBlockIds(editorShell.value?.getJSON() ?? editorContent.value)
    const text = editorShell.value?.getText() ?? plainText.value

    return {
      title: normalizeTitle(documentTitle.value),
      content,
      plainText: text,
      parentId: currentDocument.value?.parentId ?? null,
      documentKind: currentDocument.value?.documentKind ?? 'article',
      tags: currentDocument.value?.tags ?? [],
      sourceUrl: currentDocument.value?.sourceUrl ?? '',
      author: currentDocument.value?.author ?? '',
      description: currentDocument.value?.description ?? '',
    }
  },
  debounceMs: () => appSettings.value.autosaveDelay,
})

const previewJson = computed(() =>
  JSON.stringify(editorContent.value ?? EMPTY_TIPTAP_DOCUMENT, null, 2),
)
const currentDocument = computed(
  () => documents.value.find((document) => document.id === currentDocumentId.value) ?? null,
)
const renamingDocument = computed(
  () => documents.value.find((document) => document.id === renamingDocumentId.value) ?? null,
)
const propertiesDocument = computed(
  () =>
    [...documents.value, ...deletedDocuments.value].find(
      (document) => document.id === propertiesDocumentId.value,
    ) ?? null,
)
const articleGroups = computed(() =>
  documents.value.filter(
    (document) => document.documentKind === 'group' && document.parentId === null,
  ),
)
const documentForest = computed(() => buildSidebarDocumentForest(documents.value))
const ungroupedArticleNodes = computed(() => documentForest.value.rootNodes)
const searchResults = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return []

  return documents.value.filter((document) => {
    const searchableText = [
      displayTitle(document),
      document.plainText,
      document.tags.join(' '),
      document.sourceUrl,
      document.author,
      document.description,
    ]
      .join('\n')
      .toLocaleLowerCase()
    return searchableText.includes(query)
  })
})
const internalDocuments = computed(() =>
  documents.value
    .filter(
      (document) => document.documentKind === 'article' && document.id !== currentDocumentId.value,
    )
    .map((document) => ({ id: document.id, title: displayTitle(document) })),
)
const importFileAccept = computed(() =>
  selectedImportFormat.value === 'json'
    ? '.json,application/json'
    : '.md,.markdown,text/markdown,text/plain',
)
const visibleErrorMessage = computed(
  () =>
    loadError.value?.message ?? actionError.value?.message ?? autosave.error.value?.message ?? '',
)
const revisionText = computed(() => autosave.revision.value?.toString() ?? '-')
const saveStatusClass = computed(() => `save-status--${autosave.status.value}`)
const aiModeLabel = computed(() => getOptionLabel(AI_MODE_OPTIONS, aiChatMode.value))
const aiProviderLabel = computed(() =>
  getOptionLabel(AI_PROVIDER_OPTIONS, aiSettings.value.provider),
)
const aiReasoningLabel = computed(() =>
  getOptionLabel(AI_REASONING_OPTIONS, aiSettings.value.reasoningEffort),
)
const aiPromptPlaceholder = computed(() =>
  aiChatMode.value === 'edit' ? '告诉 AI 要怎么改写当前文档' : '问问当前文档，或让 AI 整理内容',
)
const aiModelOptions = computed(() =>
  getAiProviderConfig(aiSettings.value.provider).models.includes(aiSettings.value.model)
    ? getAiProviderConfig(aiSettings.value.provider).models
    : [aiSettings.value.model, ...getAiProviderConfig(aiSettings.value.provider).models],
)

const saveStatusText = computed(() => {
  if (isLoadingDocument.value) return '正在加载'
  if (loadError.value) return '加载失败'
  if (autosave.status.value === 'saved') return '已保存'
  if (autosave.status.value === 'dirty') return '有未保存更改'
  if (autosave.status.value === 'saving') return '正在保存'
  return '保存失败'
})

onMounted(async () => {
  globalThis.addEventListener('keydown', handleGlobalKeydown)
  unsubscribeSystemTheme = subscribeToSystemTheme(syncTheme)
  try {
    defaultDataDirectory.value = await getDefaultDataDirectory()
  } catch {
    // The browser development build does not expose native Tauri paths.
  }
  await initializeDocuments()
})

onBeforeUnmount(() => {
  globalThis.removeEventListener('keydown', handleGlobalKeydown)
  unsubscribeSystemTheme?.()
})

watch(
  appSettings,
  (settings) => {
    saveAppSettings(settings)
    syncTheme()
  },
  { deep: true, immediate: true },
)

watch(
  aiSettings,
  (settings) => {
    saveAiSettings(settings)
  },
  { deep: true },
)

function updateSettings(settings: AppSettings): void {
  appSettings.value = settings
}

function updateAiSettings(settings: AiSettings): void {
  aiSettings.value = settings
}

function getOptionLabel<T extends string>(options: Array<AiSelectorOption<T>>, value: T): string {
  return options.find((option) => option.value === value)?.label ?? value
}

function selectAiMode(mode: AiChatMode): void {
  aiChatMode.value = mode
}

function selectAiProvider(provider: AiProvider): void {
  const config = getAiProviderConfig(provider)
  aiSettings.value = {
    ...aiSettings.value,
    provider,
    endpoint:
      aiSettings.value.provider === provider || provider === 'openai-compatible'
        ? aiSettings.value.endpoint
        : config.endpoint,
    model:
      aiSettings.value.provider === provider || provider === 'openai-compatible'
        ? aiSettings.value.model
        : config.models[0],
  }
}

function selectAiModel(model: string): void {
  aiSettings.value = { ...aiSettings.value, model }
}

function selectAiReasoning(reasoningEffort: AiReasoningEffort): void {
  aiSettings.value = { ...aiSettings.value, reasoningEffort }
}

function getAiProviderConfig(provider: AiProvider) {
  return AI_PROVIDER_OPTIONS.find((option) => option.value === provider) ?? AI_PROVIDER_OPTIONS[0]
}

function resetSettings(): void {
  const defaults = createDefaultAppSettings()
  appSettings.value = { ...defaults, dataDirectory: appSettings.value.dataDirectory }
  aiSettings.value = { ...DEFAULT_AI_SETTINGS }
  message.success('已恢复默认设置')
}

function syncTheme(): void {
  setThemePreference(appSettings.value.theme)
  applyTheme(appSettings.value.theme)
  globalThis.document.documentElement.dataset.reduceMotion = String(appSettings.value.reduceMotion)
}

function openAiChat(): void {
  showAiChat.value = true
  if (!aiPrompt.value.trim()) {
    aiPrompt.value = '请根据当前文档，整理一版结构清晰的 Markdown 摘要。'
  }
}

function closeAiChat(): void {
  showAiChat.value = false
  aiChatFullscreen.value = false
}

function setAiChatWorkspace(workspace: boolean): void {
  showAiChat.value = true
  aiChatFullscreen.value = workspace
  if (workspace) {
    showSettings.value = false
  }
}

async function runAiAssistant(): Promise<void> {
  if (aiIsRunning.value || !aiPrompt.value.trim()) return
  const prompt = aiPrompt.value.trim()
  const mode = aiChatMode.value
  const assistantMessage: AiChatMessage = {
    id: createDocumentId(),
    role: 'assistant',
    mode,
    content: '',
    status: 'streaming',
  }
  const blockQueue =
    mode === 'edit'
      ? createMarkdownBlockStreamQueue((markdown) => {
          editorShell.value?.insertMarkdown(markdown)
        })
      : null

  aiMessages.value.push({
    id: createDocumentId(),
    role: 'user',
    mode,
    content: prompt,
    status: 'done',
  })
  aiMessages.value.push(assistantMessage)
  const assistantIndex = aiMessages.value.length - 1
  aiPrompt.value = ''
  aiIsRunning.value = true
  aiError.value = ''
  aiAbortController = new globalThis.AbortController()

  try {
    await runAiMarkdownCompletion({
      prompt: buildAiPrompt(prompt, mode),
      context: buildAiContext(),
      settings: aiSettings.value,
      signal: aiAbortController.signal,
      onDelta: (delta) => {
        const currentMessage = aiMessages.value[assistantIndex]
        if (currentMessage) {
          currentMessage.content += delta
        }
        blockQueue?.push(delta)
      },
    })
    blockQueue?.flush()
    if (aiMessages.value[assistantIndex]) {
      aiMessages.value[assistantIndex].status = 'done'
    }
  } catch (error) {
    if ((error as { name?: string }).name !== 'AbortError') {
      aiError.value = error instanceof Error ? error.message : String(error)
      if (aiMessages.value[assistantIndex]) {
        aiMessages.value[assistantIndex].status = 'error'
        aiMessages.value[assistantIndex].content ||= aiError.value
      }
    } else {
      blockQueue?.flush()
      if (aiMessages.value[assistantIndex]) {
        aiMessages.value[assistantIndex].status = 'done'
      }
    }
  } finally {
    aiIsRunning.value = false
    aiAbortController = null
  }
}

function stopAiAssistant(): void {
  aiAbortController?.abort()
}

function clearAiChat(): void {
  if (aiIsRunning.value) {
    stopAiAssistant()
  }
  aiMessages.value = []
  aiError.value = ''
}

function insertAiMessage(content: string): void {
  if (!content.trim()) return
  editorShell.value?.insertMarkdown(content)
  message.success('AI 回复已插入文档')
}

function buildAiPrompt(prompt: string, mode: AiChatMode): string {
  if (mode === 'ask') {
    return prompt
  }

  return [
    '请根据用户要求为当前文档生成可直接插入的 Markdown 内容。',
    '输出必须是 Markdown 正文，不要解释你的操作。',
    '用户要求：',
    prompt,
  ].join('\n')
}

function buildAiContext(): string {
  const document = currentDocument.value
  const lines = [
    '标题：' + normalizeTitle(documentTitle.value),
    '标签：' + (document?.tags.join('、') || '无'),
    '来源：' + (document?.sourceUrl || '无'),
    '作者：' + (document?.author || '无'),
    '',
    '正文：',
    editorShell.value?.getText() || plainText.value,
  ]
  return lines.join('\n')
}

function createMarkdownBlockStreamQueue(onBlock: (markdown: string) => void): {
  push: (delta: string) => void
  flush: () => void
} {
  let buffer = ''

  function drain(force: boolean): void {
    while (buffer.trim()) {
      const next = takeCompleteMarkdownBlock(buffer, force)
      if (!next) return
      buffer = next.rest
      if (next.block.trim()) {
        onBlock(next.block)
      }
    }
  }

  return {
    push(delta: string) {
      buffer += delta.replace(/\r\n?/g, '\n')
      drain(false)
    },
    flush() {
      drain(true)
      buffer = ''
    },
  }
}

function takeCompleteMarkdownBlock(
  markdown: string,
  force: boolean,
): { block: string; rest: string } | null {
  const source = markdown.replace(/^\n+/, '')
  if (!source.trim()) {
    return { block: '', rest: '' }
  }

  if (source.startsWith('```')) {
    const closingEnd = findClosingFenceEnd(source, '```')
    if (closingEnd >= 0) {
      return { block: source.slice(0, closingEnd).trimEnd(), rest: source.slice(closingEnd) }
    }
    return force ? { block: source.trimEnd(), rest: '' } : null
  }

  if (source.trimStart().startsWith('$$')) {
    const closingEnd = findClosingMathFenceEnd(source, '$$')
    if (closingEnd >= 0) {
      return { block: source.slice(0, closingEnd).trimEnd(), rest: source.slice(closingEnd) }
    }
    return force ? { block: source.trimEnd(), rest: '' } : null
  }

  const blankLineMatch = source.match(/\n\s*\n/)
  if (blankLineMatch?.index !== undefined) {
    return {
      block: source.slice(0, blankLineMatch.index).trimEnd(),
      rest: source.slice(blankLineMatch.index + blankLineMatch[0].length),
    }
  }

  const firstNewline = source.indexOf('\n')
  if (firstNewline >= 0 && isSingleLineMarkdownBlock(source.slice(0, firstNewline))) {
    return { block: source.slice(0, firstNewline).trimEnd(), rest: source.slice(firstNewline + 1) }
  }

  return force ? { block: source.trimEnd(), rest: '' } : null
}

function findClosingFenceEnd(markdown: string, fence: string): number {
  const lines = markdown.split('\n')
  for (let index = 1, cursor = lines[0].length + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const end = cursor + line.length + (index < lines.length - 1 ? 1 : 0)
    if (line.trim() === fence) {
      return end
    }
    cursor = end
  }
  return -1
}

function findClosingMathFenceEnd(markdown: string, fence: '$$'): number {
  const start = markdown.indexOf(fence)
  const end = markdown.indexOf(fence, start + fence.length)
  return end >= 0 ? end + fence.length : -1
}

function isSingleLineMarkdownBlock(line: string): boolean {
  return /^(#{1,4})\s+\S/.test(line) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
}

function renderMarkdownMessage(markdown: string): string {
  if (!markdown.trim()) {
    return '<p class="markdown-preview__empty">等待输出...</p>'
  }
  const parsed = parseMarkdownDocument(markdown, 'AI 回复')
  const nodes = parsed.content.content ?? []
  return (
    nodes.map(renderTiptapNode).join('') || '<p class="markdown-preview__empty">等待输出...</p>'
  )
}

function renderTiptapNode(node: Record<string, unknown>): string {
  const type = String(node.type ?? '')
  const content = Array.isArray(node.content) ? (node.content as Record<string, unknown>[]) : []
  const attrs = isRecord(node.attrs) ? node.attrs : {}

  if (type === 'text') {
    return renderTextNode(node)
  }

  if (type === 'paragraph') {
    return `<p>${content.map(renderTiptapNode).join('') || '&nbsp;'}</p>`
  }

  if (type === 'heading') {
    const level = Math.max(1, Math.min(Number(attrs.level) || 2, 4))
    return `<h${level}>${content.map(renderTiptapNode).join('')}</h${level}>`
  }

  if (type === 'blockquote') {
    return `<blockquote>${content.map(renderTiptapNode).join('')}</blockquote>`
  }

  if (type === 'bulletList' || type === 'orderedList') {
    const tag = type === 'orderedList' ? 'ol' : 'ul'
    return `<${tag}>${content.map(renderTiptapNode).join('')}</${tag}>`
  }

  if (type === 'listItem') {
    return `<li>${content.map(renderTiptapNode).join('')}</li>`
  }

  if (type === 'codeBlock') {
    return `<pre><code>${escapeHtml(getPlainNodeText(node))}</code></pre>`
  }

  if (type === 'mathBlock') {
    return `<pre class="markdown-preview__math"><code>${escapeHtml(String(attrs.latex ?? ''))}</code></pre>`
  }

  if (type === 'horizontalRule') {
    return '<hr>'
  }

  if (type === 'tableBlock') {
    const rows = Array.isArray(attrs.rows) ? (attrs.rows as unknown[][]) : []
    return renderTableRows(rows)
  }

  return content.map(renderTiptapNode).join('')
}

function renderTextNode(node: Record<string, unknown>): string {
  let html = escapeHtml(String(node.text ?? ''))
  const marks = Array.isArray(node.marks) ? (node.marks as Record<string, unknown>[]) : []

  for (const mark of marks) {
    const type = String(mark.type ?? '')
    const attrs = isRecord(mark.attrs) ? mark.attrs : {}
    if (type === 'bold') html = `<strong>${html}</strong>`
    if (type === 'italic') html = `<em>${html}</em>`
    if (type === 'code') html = `<code>${html}</code>`
    if (type === 'link') {
      const href = sanitizeHref(String(attrs.href ?? ''))
      html = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${html}</a>`
        : html
    }
  }

  return html
}

function renderTableRows(rows: unknown[][]): string {
  if (rows.length === 0) return ''
  const [head, ...body] = rows
  const header = `<thead><tr>${head.map((cell) => `<th>${escapeHtml(String(cell ?? ''))}</th>`).join('')}</tr></thead>`
  const bodyRows = body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell ?? ''))}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<table>${header}<tbody>${bodyRows}</tbody></table>`
}

function getPlainNodeText(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text
  const content = Array.isArray(node.content) ? (node.content as Record<string, unknown>[]) : []
  return content.map(getPlainNodeText).join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeHref(href: string): string {
  const trimmed = href.trim()
  return /^(https?:|mailto:|#)/i.test(trimmed) ? trimmed : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function chooseDataDirectory(): Promise<void> {
  const selected = await open({
    title: '选择知识库数据目录',
    directory: true,
    multiple: false,
    defaultPath: (appSettings.value.dataDirectory ?? defaultDataDirectory.value) || undefined,
  })
  if (typeof selected !== 'string' || !selected.trim()) return
  if (selected === appSettings.value.dataDirectory) return
  await changeDataDirectory(selected)
}

async function restoreDefaultDataDirectory(): Promise<void> {
  if (!appSettings.value.dataDirectory) return
  await changeDataDirectory(null)
}

async function changeDataDirectory(destinationDirectory: string | null): Promise<void> {
  if (isChangingDataDirectory.value) return
  isChangingDataDirectory.value = true
  const previousSettings = appSettings.value

  try {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) {
      message.error('当前文档保存失败，未切换数据目录')
      return
    }

    await closeDatabase()
    const change = await migrateDataDirectory(previousSettings.dataDirectory, destinationDirectory)
    appSettings.value = { ...previousSettings, dataDirectory: destinationDirectory }
    saveAppSettings(appSettings.value)
    documentService.value = null
    await initializeDocuments()

    message.success(
      change.backupPath ? '数据位置已切换，目标目录中的旧数据库已自动备份' : '数据位置已切换',
    )
  } catch (error) {
    appSettings.value = previousSettings
    saveAppSettings(previousSettings)
    documentService.value = null
    try {
      await initializeDocuments()
    } catch {
      // initializeDocuments already exposes its own load error state.
    }
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    isChangingDataDirectory.value = false
  }
}

function handleEditorContentUpdate(content: TiptapDocumentJson): void {
  editorContent.value = ensureTopLevelBlockIds(content)

  if (!isLoadingDocument.value && !loadError.value) {
    autosave.markDirty()
  }
}

function handleTextUpdate(text: string): void {
  plainText.value = text
}

function handleTitleInput(): void {
  if (!isLoadingDocument.value && !loadError.value) {
    autosave.markDirty()
  }
}

async function initializeDocuments(): Promise<void> {
  isLoadingDocument.value = true
  loadError.value = null

  try {
    const repository = await createDocumentRepository()
    const service = new DocumentService(repository)
    documentService.value = service

    await refreshDocumentLists()

    const lastDocumentId = globalThis.localStorage?.getItem(LAST_DOCUMENT_STORAGE_KEY)
    const firstDocument =
      (appSettings.value.startupBehavior === 'last'
        ? documents.value.find(
            (document) => document.id === lastDocumentId && document.documentKind === 'article',
          )
        : undefined) ?? documents.value.find((document) => document.documentKind === 'article')
    if (firstDocument) {
      await loadDocument(firstDocument.id)
      return
    }

    const created = await createDocument(INITIAL_TITLE)
    if (created) {
      await loadDocument(created.id)
    }
  } catch (error) {
    loadError.value = {
      code: 'unknown',
      message: error instanceof Error ? error.message : 'Failed to initialize documents.',
      cause: error,
    }
  } finally {
    isLoadingDocument.value = false
  }
}

async function refreshDocumentLists(): Promise<void> {
  const service = requireDocumentService()
  const [recentResult, deletedResult] = await Promise.all([
    service.listRecentDocuments(200),
    service.listDeletedDocuments(200),
  ])

  if (!recentResult.ok) {
    actionError.value = recentResult.error
    return
  }

  if (!deletedResult.ok) {
    actionError.value = deletedResult.error
    return
  }

  documents.value = recentResult.value
  deletedDocuments.value = deletedResult.value
  actionError.value = null
}

async function createAndOpenDocument(parentId: DocumentId | null = null): Promise<void> {
  await runDocumentAction(async () => {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) return

    const created = await createDocument('新文档', { parentId })
    if (!created) return

    await refreshDocumentLists()
    if (parentId && isArticleDocument(parentId)) {
      expandDocument(parentId)
    }
    await loadDocument(created.id)
  })
}

function createGroup(): void {
  newGroupTitle.value = '新分组'
  showCreateGroupModal.value = true
}

async function confirmCreateGroup(): Promise<void> {
  const nextTitle = normalizeTitle(newGroupTitle.value)
  showCreateGroupModal.value = false

  await runDocumentAction(async () => {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) return

    const created = await createDocument(nextTitle, {
      documentKind: 'group',
      content: createEmptyDocumentContent(),
      plainText: '',
    })
    if (!created) return

    selectedGroupId.value = created.id
    expandGroup(created.id)
    await refreshDocumentLists()
    message.success('分组已创建')
  })
}

async function selectDocument(documentId: DocumentId): Promise<void> {
  if (documentId === currentDocumentId.value) return

  await runDocumentAction(async () => {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) return

    await loadDocument(documentId)
  })
}

async function loadDocument(documentId: DocumentId): Promise<void> {
  const service = requireDocumentService()
  isLoadingDocument.value = true
  loadError.value = null

  const result = await service.getDocument(documentId)
  if (!result.ok) {
    loadError.value = result.error
    isLoadingDocument.value = false
    return
  }

  if (result.value.documentKind === 'group') {
    selectedGroupId.value = result.value.id
    expandGroup(result.value.id)
    isLoadingDocument.value = false
    return
  }

  currentDocumentId.value = result.value.id
  globalThis.localStorage?.setItem(LAST_DOCUMENT_STORAGE_KEY, result.value.id)
  revealDocumentInSidebar(result.value.id)
  documentTitle.value = normalizeTitle(result.value.title)
  editorContent.value = ensureTopLevelBlockIds(parseEditorContentJson(result.value.contentJson))
  plainText.value = result.value.plainText
  autosave.resetSavedState(result.value.revision)
  renamingDocumentId.value = null
  isLoadingDocument.value = false
  await refreshDocumentLists()
}

function startRename(document: DocumentSummary): void {
  renamingDocumentId.value = document.id
  renameTitle.value = displayTitle(document)
  showRenameModal.value = true
}

function openDocumentProperties(document: DocumentSummary): void {
  propertiesDocumentId.value = document.id
  propertiesDraftTags.value = document.tags.join('、')
  propertiesDraftSourceUrl.value = document.sourceUrl
  propertiesDraftAuthor.value = document.author
  propertiesDraftDescription.value = document.description
  showPropertiesModal.value = true
}

function resetPropertiesState(): void {
  propertiesDocumentId.value = null
  propertiesDraftTags.value = ''
  propertiesDraftSourceUrl.value = ''
  propertiesDraftAuthor.value = ''
  propertiesDraftDescription.value = ''
  isSavingProperties.value = false
}

async function saveDocumentProperties(): Promise<void> {
  const document = propertiesDocument.value
  if (!document || isSavingProperties.value) return
  isSavingProperties.value = true

  try {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) {
      message.error('当前文档保存失败，属性未更新')
      return
    }

    const result = await requireDocumentService().updateDocument({
      id: document.id,
      expectedRevision: document.revision,
      tags: parseTagsInput(propertiesDraftTags.value),
      sourceUrl: propertiesDraftSourceUrl.value.trim(),
      author: propertiesDraftAuthor.value.trim(),
      description: propertiesDraftDescription.value.trim(),
    })
    if (!result.ok) {
      actionError.value = result.error
      message.error(result.error.message)
      return
    }

    await refreshDocumentLists()
    if (result.value.id === currentDocumentId.value) {
      autosave.resetSavedState(result.value.revision)
    }
    showPropertiesModal.value = false
    message.success('属性已保存')
  } finally {
    isSavingProperties.value = false
  }
}

function cancelRename(): void {
  showRenameModal.value = false
  renamingDocumentId.value = null
  renameTitle.value = ''
}

function resetRenameState(): void {
  renamingDocumentId.value = null
  renameTitle.value = ''
}

async function commitRename(): Promise<void> {
  const document = renamingDocument.value
  if (!document) {
    cancelRename()
    return
  }

  const nextTitle = normalizeTitle(renameTitle.value)
  if (nextTitle === displayTitle(document)) {
    cancelRename()
    return
  }

  await runDocumentAction(async () => {
    if (document.id === currentDocumentId.value) {
      const flushResult = await autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) {
        actionError.value = flushResult.error
        message.error(flushResult.error.message)
        return
      }
    }

    const service = requireDocumentService()
    const expectedRevision =
      document.id === currentDocumentId.value ? autosave.revision.value : document.revision
    if (expectedRevision === null) {
      actionError.value = {
        code: 'revision-conflict',
        message: '当前文档还没有可用于重命名的 revision。',
      }
      return
    }

    const result = await service.updateDocument({
      id: document.id,
      expectedRevision,
      title: nextTitle,
    })

    if (!result.ok) {
      actionError.value = result.error
      return
    }

    if (document.id === currentDocumentId.value) {
      documentTitle.value = result.value.title
      autosave.resetSavedState(result.value.revision)
    }

    cancelRename()
    await refreshDocumentLists()
  })
}

function openSearch(): void {
  sidebarView.value = 'documents'
  showSearchModal.value = true
}

function closeSearch(): void {
  showSearchModal.value = false
  searchQuery.value = ''
}

async function openFirstSearchResult(): Promise<void> {
  const firstResult = searchResults.value[0]
  if (firstResult) {
    await openSearchResult(firstResult)
  }
}

async function openSearchResult(document: DocumentSummary): Promise<void> {
  closeSearch()

  if (document.documentKind === 'group') {
    selectedGroupId.value = document.id
    expandGroup(document.id)
    return
  }

  await selectDocument(document.id)
}

function getSearchSnippet(document: DocumentSummary): string {
  if (document.documentKind === 'group') {
    return `${getGroupArticleCount(document.id)} 个页面`
  }

  const normalized = document.plainText.replace(/\s+/g, ' ').trim()
  return normalized || '暂无正文'
}

function handleGlobalKeydown(event: BrowserKeyboardEvent): void {
  const shortcuts = appSettings.value.shortcuts
  if (matchesShortcut(event, shortcuts.search)) {
    event.preventDefault()
    openSearch()
  } else if (matchesShortcut(event, shortcuts.newDocument)) {
    event.preventDefault()
    const parentId =
      appSettings.value.newDocumentLocation === 'current' ? currentDocumentId.value : null
    void createAndOpenDocument(parentId)
  } else if (matchesShortcut(event, shortcuts.save)) {
    event.preventDefault()
    void autosave.flush()
  } else if (matchesShortcut(event, shortcuts.openSettings)) {
    event.preventDefault()
    showSettings.value = true
  } else if (matchesShortcut(event, shortcuts.importDocument)) {
    event.preventDefault()
    importDocumentFile()
  }
}

function handleArticleDragStart(event: BrowserDragEvent, document: DocumentSummary): void {
  if (isBusy.value || document.documentKind !== 'article') {
    event.preventDefault()
    return
  }

  draggedArticleId.value = document.id
  event.dataTransfer?.setData('text/plain', document.id)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.dropEffect = 'move'
  }
}

function handleArticleDragEnd(): void {
  draggedArticleId.value = null
  dropTargetGroupId.value = null
}

function handleGroupDragOver(event: BrowserDragEvent, groupId: DocumentId): void {
  if (canDropArticleIntoGroup(groupId)) {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
    dropTargetGroupId.value = groupId
  }
}

function canDropArticleIntoGroup(groupId: DocumentId): boolean {
  const draggedArticle = documents.value.find((document) => document.id === draggedArticleId.value)
  return draggedArticle?.documentKind === 'article' && draggedArticle.parentId !== groupId
}

function handleGroupDragLeave(event: BrowserDragEvent, groupId: DocumentId): void {
  const target = event.currentTarget
  const relatedTarget = event.relatedTarget
  if (
    target instanceof globalThis.HTMLElement &&
    relatedTarget instanceof globalThis.Node &&
    target.contains(relatedTarget)
  )
    return
  if (dropTargetGroupId.value === groupId) {
    dropTargetGroupId.value = null
  }
}

async function handleGroupDrop(event: BrowserDragEvent, groupId: DocumentId): Promise<void> {
  event.preventDefault()
  const articleId = draggedArticleId.value ?? event.dataTransfer?.getData('text/plain') ?? null
  handleArticleDragEnd()
  if (!articleId) return

  const article = documents.value.find(
    (document) => document.id === articleId && document.documentKind === 'article',
  )
  if (!article || article.parentId === groupId) return

  await moveArticleToGroup(article, groupId)
}

async function moveArticleToGroup(article: DocumentSummary, groupId: DocumentId): Promise<void> {
  await runDocumentAction(async () => {
    const targetGroup = documents.value.find((document) => document.id === groupId)
    const targetGroupTitle = targetGroup ? displayTitle(targetGroup) : '分组'

    if (article.id === currentDocumentId.value) {
      const flushResult = await autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) {
        message.error(flushResult.error.message)
        return
      }
    }

    const expectedRevision =
      article.id === currentDocumentId.value ? autosave.revision.value : article.revision
    if (expectedRevision === null) {
      message.error('文章版本尚未就绪，请稍后重试。')
      return
    }

    const service = requireDocumentService()
    const result = await service.updateDocument({
      id: article.id,
      expectedRevision,
      parentId: groupId,
    })
    if (!result.ok) {
      actionError.value = result.error
      message.error(result.error.message)
      return
    }

    if (article.id === currentDocumentId.value) {
      autosave.resetSavedState(result.value.revision)
    }

    selectedGroupId.value = groupId
    expandGroup(groupId)
    await refreshDocumentLists()
    message.success(`已移动到「${targetGroupTitle}」`)
  })
}

async function commitCurrentTitle(): Promise<void> {
  const activeDocument = currentDocument.value
  if (!activeDocument) return

  const nextTitle = normalizeTitle(documentTitle.value)
  documentTitle.value = nextTitle

  if (nextTitle === displayTitle(activeDocument)) return

  await runDocumentAction(async () => {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) return

    if (flushResult.value && normalizeTitle(flushResult.value.title) === nextTitle) {
      documentTitle.value = normalizeTitle(flushResult.value.title)
      await refreshDocumentLists()
      return
    }

    const expectedRevision = autosave.revision.value
    if (expectedRevision === null) {
      actionError.value = {
        code: 'revision-conflict',
        message: '当前文档还没有可用于重命名的 revision。',
      }
      return
    }

    const service = requireDocumentService()
    const result = await service.updateDocument({
      id: activeDocument.id,
      expectedRevision,
      title: nextTitle,
    })

    if (!result.ok) {
      actionError.value = result.error
      return
    }

    documentTitle.value = result.value.title
    autosave.resetSavedState(result.value.revision)
    await refreshDocumentLists()
  })
}

async function deleteDocument(document: DocumentSummary): Promise<void> {
  const confirmed = await confirmDeleteDocument(document)
  if (!confirmed) return

  await runDocumentAction(async () => {
    const descendants = collectArticleDescendants(documents.value, document.id)
    const documentsToDelete = [document, ...descendants]
    const deletingCurrentDocument = documentsToDelete.some(
      (candidate) => candidate.id === currentDocumentId.value,
    )

    if (deletingCurrentDocument) {
      const flushResult = await autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) return
    }

    const service = requireDocumentService()
    for (const candidate of [...documentsToDelete].reverse()) {
      const expectedRevision =
        candidate.id === currentDocumentId.value ? autosave.revision.value : candidate.revision
      if (expectedRevision === null) {
        message.error('文档版本尚未就绪，请稍后重试。')
        return
      }

      const result = await service.deleteDocument(candidate.id, expectedRevision)
      if (!result.ok) {
        actionError.value = result.error
        message.error(result.error.message)
        return
      }
    }

    await refreshDocumentLists()

    if (deletingCurrentDocument) {
      const nextDocument = documents.value.find((item) => item.documentKind === 'article')
      if (nextDocument) {
        await loadDocument(nextDocument.id)
      } else {
        const created = await createDocument(INITIAL_TITLE)
        if (created) {
          await refreshDocumentLists()
          await loadDocument(created.id)
        }
      }
    }

    message.success(
      descendants.length > 0
        ? `页面及 ${descendants.length} 个子页面已移入回收站`
        : '页面已移入回收站',
    )
  })
}

async function restoreDocument(document: DocumentSummary): Promise<void> {
  await runDocumentAction(async () => {
    const service = requireDocumentService()
    const descendants = collectArticleDescendants(deletedDocuments.value, document.id)

    for (const candidate of [document, ...descendants]) {
      const result = await service.restoreDocument(candidate.id, candidate.revision)
      if (!result.ok) {
        actionError.value = result.error
        message.error(result.error.message)
        return
      }
    }

    await refreshDocumentLists()
    sidebarView.value = 'documents'
    await loadDocument(document.id)
    message.success(descendants.length > 0 ? '页面及其子页面已恢复' : '页面已恢复')
  })
}

async function permanentlyDeleteDocument(document: DocumentSummary): Promise<void> {
  const confirmed = await confirmPermanentDeleteDocument(document)
  if (!confirmed) return

  await runDocumentAction(async () => {
    const service = requireDocumentService()
    const descendants = collectArticleDescendants(deletedDocuments.value, document.id)

    for (const candidate of [document, ...descendants].reverse()) {
      const result = await service.permanentlyDeleteDocument(candidate.id, candidate.revision)
      if (!result.ok) {
        actionError.value = result.error
        message.error(result.error.message)
        return
      }
    }

    await refreshDocumentLists()
    message.success(descendants.length > 0 ? '页面及其子页面已彻底删除' : '页面已彻底删除')
  })
}

function importDocumentFile(): void {
  showImportModal.value = true
}

async function chooseImportFormat(format: ImportFormat): Promise<void> {
  selectedImportFormat.value = format
  showImportModal.value = false
  await nextTick()
  importFileInput.value?.click()
}

async function handleImportFileChange(event: { target: unknown }): Promise<void> {
  const input = event.target as MarkdownFileInput
  const file = input.files?.[0]
  input.value = ''

  if (!file) return

  const importFormat = selectedImportFormat.value ?? inferImportFormat(file.name)
  selectedImportFormat.value = null

  if (!importFormat) {
    actionError.value = {
      code: 'validation-error',
      message: '请选择 .json、.md 或 .markdown 文件。',
    }
    message.error(actionError.value.message)
    return
  }

  await runDocumentAction(async () => {
    const flushResult = await autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) return

    const fileContent = await file.text()
    let parsed: { title: string; content: TiptapDocumentJson; plainText: string }

    try {
      parsed =
        importFormat === 'json'
          ? parseNotebookJsonDocument(fileContent, file.name)
          : parseMarkdownDocument(fileContent, file.name)
    } catch (error) {
      actionError.value = {
        code: 'validation-error',
        message: error instanceof Error ? error.message : '文件格式无法识别。',
        cause: error,
      }
      message.error(actionError.value.message)
      return
    }

    const created = await createDocument(parsed.title, {
      parentId: getActiveGroupId(),
      content: parsed.content,
      plainText: parsed.plainText,
    })
    if (!created) return

    await refreshDocumentLists()
    await loadDocument(created.id)
    message.success(importFormat === 'json' ? 'JSON 已导入' : 'Markdown 已导入')
  })
}

function inferImportFormat(fileName: string): ImportFormat | null {
  if (/\.json$/i.test(fileName)) return 'json'
  if (/\.(md|markdown)$/i.test(fileName)) return 'markdown'
  return null
}

async function openShareView(): Promise<void> {
  if (isPreparingShare.value) return
  isPreparingShare.value = true
  try {
    const prepared = await prepareCurrentDocumentExport()
    if (!prepared) return
    shareMarkdown.value = prepared.markdown
    shareHtml.value = prepared.html
    showShareModal.value = true
  } finally {
    isPreparingShare.value = false
  }
}

async function exportCurrentDocument(format: 'markdown' | 'html'): Promise<void> {
  const prepared = await prepareCurrentDocumentExport()
  if (!prepared) return
  const extension = format === 'markdown' ? 'md' : 'html'
  const path = await save({
    title: format === 'markdown' ? '导出 Markdown' : '导出 HTML',
    defaultPath: safeExportFileName(documentTitle.value, extension),
    filters: [
      {
        name: format === 'markdown' ? 'Markdown' : 'HTML',
        extensions: [extension],
      },
    ],
  })
  if (!path) return

  await invoke('write_text_file', {
    path,
    content: format === 'markdown' ? prepared.markdown : prepared.html,
  })
  message.success(format === 'markdown' ? 'Markdown 已导出' : 'HTML 已导出')
}

async function prepareCurrentDocumentExport(): Promise<{ markdown: string; html: string } | null> {
  const document = currentDocument.value
  if (!document) return null

  const flushResult = await autosave.flushBeforeDocumentChange()
  if (!flushResult.ok) {
    message.error('当前文档保存失败，暂不能导出')
    return null
  }

  const content = ensureTopLevelBlockIds(editorShell.value?.getJSON() ?? editorContent.value)
  const metadata = metadataFromDocument({
    ...document,
    title: normalizeTitle(documentTitle.value),
  })
  const [markdown, html] = await Promise.all([
    exportDocumentToMarkdown(content, metadata),
    exportDocumentToHtml(content, metadata),
  ])
  return { markdown, html }
}

function safeExportFileName(title: string, extension: string): string {
  const baseName =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 80) || INITIAL_TITLE
  return baseName + '.' + extension
}

async function createDocument(
  title: string,
  options: CreateDocumentOptions = {},
): Promise<DocumentSummary | null> {
  const service = requireDocumentService()
  const documentId = createDocumentId()
  const content = options.content ?? createInitialDocumentContent(title)
  const plainTextValue = options.plainText ?? `${normalizeTitle(title)}\n`
  const result = await service.saveDocument({
    id: documentId,
    expectedRevision: null,
    parentId: options.parentId ?? null,
    documentKind: options.documentKind ?? 'article',
    title: normalizeTitle(title),
    contentJson: JSON.stringify(content),
    plainText: plainTextValue,
  })

  if (!result.ok) {
    actionError.value = result.error
    return null
  }

  return {
    id: result.value.id,
    parentId: result.value.parentId,
    documentKind: result.value.documentKind,
    title: result.value.title,
    plainText: result.value.plainText,
    revision: result.value.revision,
    sortOrder: result.value.sortOrder,
    isDeleted: result.value.isDeleted,
    createdAt: result.value.createdAt,
    updatedAt: result.value.updatedAt,
  }
}

async function runDocumentAction(action: () => Promise<void>): Promise<void> {
  if (isBusy.value) return

  isBusy.value = true
  actionError.value = null

  try {
    await action()
  } catch (error) {
    actionError.value = {
      code: 'unknown',
      message: error instanceof Error ? error.message : '文档操作失败。',
      cause: error,
    }
  } finally {
    isBusy.value = false
  }
}

function toggleGroup(groupId: DocumentId): void {
  selectedGroupId.value = groupId
  const nextCollapsedGroupIds = new Set(collapsedGroupIds.value)

  if (nextCollapsedGroupIds.has(groupId)) {
    nextCollapsedGroupIds.delete(groupId)
  } else {
    nextCollapsedGroupIds.add(groupId)
  }

  collapsedGroupIds.value = nextCollapsedGroupIds
}

function toggleDocument(documentId: DocumentId): void {
  const nextCollapsedDocumentIds = new Set(collapsedDocumentIds.value)

  if (nextCollapsedDocumentIds.has(documentId)) {
    nextCollapsedDocumentIds.delete(documentId)
  } else {
    nextCollapsedDocumentIds.add(documentId)
  }

  collapsedDocumentIds.value = nextCollapsedDocumentIds
}

function expandDocument(documentId: DocumentId): void {
  const nextCollapsedDocumentIds = new Set(collapsedDocumentIds.value)
  nextCollapsedDocumentIds.delete(documentId)
  collapsedDocumentIds.value = nextCollapsedDocumentIds
}

function expandGroup(groupId: DocumentId): void {
  const nextCollapsedGroupIds = new Set(collapsedGroupIds.value)
  nextCollapsedGroupIds.delete(groupId)
  collapsedGroupIds.value = nextCollapsedGroupIds
}

function isGroupCollapsed(groupId: DocumentId): boolean {
  return collapsedGroupIds.value.has(groupId)
}

function getGroupArticleNodes(groupId: DocumentId) {
  return documentForest.value.nodesByGroup.get(groupId) ?? []
}

function getGroupArticleCount(groupId: DocumentId): number {
  return countSidebarDocumentNodes(getGroupArticleNodes(groupId))
}

function isArticleDocument(documentId: DocumentId): boolean {
  return documents.value.some(
    (document) => document.id === documentId && document.documentKind === 'article',
  )
}

function revealDocumentInSidebar(documentId: DocumentId): void {
  const nextCollapsedDocumentIds = new Set(collapsedDocumentIds.value)
  const visited = new Set<DocumentId>()
  let document = documents.value.find((candidate) => candidate.id === documentId) ?? null
  let groupId: DocumentId | null = null

  while (document?.parentId && !visited.has(document.parentId)) {
    visited.add(document.parentId)
    const parent = documents.value.find((candidate) => candidate.id === document?.parentId)
    if (!parent) break

    if (parent.documentKind === 'group') {
      groupId = parent.id
      break
    }

    nextCollapsedDocumentIds.delete(parent.id)
    document = parent
  }

  collapsedDocumentIds.value = nextCollapsedDocumentIds
  selectedGroupId.value = groupId
  if (groupId) expandGroup(groupId)
}

function getActiveGroupId(): DocumentId | null {
  const groupId = selectedGroupId.value
  if (!groupId) return null

  return documents.value.some(
    (document) => document.id === groupId && document.documentKind === 'group',
  )
    ? groupId
    : null
}

function requireDocumentService(): DocumentService {
  if (!documentService.value) {
    throw new Error('Document service is not ready.')
  }

  return documentService.value
}

function confirmDeleteDocument(document: DocumentSummary): Promise<boolean> {
  if (!appSettings.value.confirmBeforeDelete) return Promise.resolve(true)
  const descendantCount = collectArticleDescendants(documents.value, document.id).length
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    dialog.warning({
      title: '删除页面',
      content:
        descendantCount > 0
          ? `删除「${displayTitle(document)}」及其 ${descendantCount} 个子页面？可在回收站恢复。`
          : `删除「${displayTitle(document)}」？可在回收站恢复。`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

function confirmPermanentDeleteDocument(document: DocumentSummary): Promise<boolean> {
  if (!appSettings.value.confirmBeforeDelete) return Promise.resolve(true)
  const descendantCount = collectArticleDescendants(deletedDocuments.value, document.id).length
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    dialog.warning({
      title: '彻底删除页面',
      content:
        descendantCount > 0
          ? `彻底删除「${displayTitle(document)}」及其 ${descendantCount} 个子页面？此操作无法恢复。`
          : `彻底删除「${displayTitle(document)}」？此操作无法恢复。`,
      positiveText: '彻底删除',
      negativeText: '取消',
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

function createInitialDocumentContent(title: string): TiptapDocumentJson {
  return ensureTopLevelBlockIds({
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: {
          level: 1,
        },
        content: [{ type: 'text', text: normalizeTitle(title) }],
      },
      {
        type: 'paragraph',
      },
    ],
  })
}

function createEmptyDocumentContent(): TiptapDocumentJson {
  return ensureTopLevelBlockIds({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  })
}

function createDocumentId(): DocumentId {
  if (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID()
  }

  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeTitle(title: string): string {
  const normalized = title.trim()
  return normalized.length > 0 ? normalized.slice(0, 80) : INITIAL_TITLE
}

function parseTagsInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[，,、#\n]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => tag.slice(0, 40)),
    ),
  ).slice(0, 20)
}

function displayTitle(document: DocumentSummary): string {
  return normalizeTitle(document.title)
}

function formatUpdatedAt(updatedAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(updatedAt))
}

function formatDocumentDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function documentParentTitle(document: DocumentSummary): string {
  if (document.parentId === null) return '顶层页面'
  const parent = documents.value.find((candidate) => candidate.id === document.parentId)
  if (!parent) return '未知位置'
  return parent.documentKind === 'group'
    ? `分组 · ${displayTitle(parent)}`
    : `父页面 · ${displayTitle(parent)}`
}

function documentCharacterCount(document: DocumentSummary): number {
  return Array.from(document.plainText.trim()).length
}
</script>

<template>
  <main class="app-shell">
    <section
      class="editor-workspace"
      :class="{ 'editor-workspace--ai-workspace': showAiChat && aiChatFullscreen }"
    >
      <aside class="document-sidebar" aria-label="文档管理">
        <div class="sidebar-quickbar" aria-label="快捷入口">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                class="sidebar-quickbar__button"
                quaternary
                circle
                aria-label="搜索"
                @click="openSearch"
              >
                <template #icon>
                  <NIcon :size="21"><Search /></NIcon>
                </template>
              </NButton>
            </template>
            搜索
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                class="sidebar-quickbar__button"
                quaternary
                circle
                aria-label="设置"
                @click="showSettings = true"
              >
                <template #icon>
                  <NIcon :size="21"><Settings /></NIcon>
                </template>
              </NButton>
            </template>
            设置
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                class="sidebar-quickbar__button"
                quaternary
                circle
                aria-label="导入"
                @click="importDocumentFile"
              >
                <template #icon>
                  <NIcon :size="21"><Upload /></NIcon>
                </template>
              </NButton>
            </template>
            导入 JSON / Markdown
          </NTooltip>
          <input
            ref="importFileInput"
            class="file-input-hidden"
            type="file"
            :accept="importFileAccept"
            @change="handleImportFileChange"
          />
        </div>

        <div class="sidebar-section-heading">
          <span>空间</span>
          <NButtonGroup class="sidebar-section-heading__actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  circle
                  aria-label="新建分组"
                  :disabled="isBusy"
                  @click="createGroup"
                >
                  <template #icon>
                    <NIcon :size="14"><Folder /></NIcon>
                  </template>
                </NButton>
              </template>
              新建分组
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  circle
                  aria-label="新建页面"
                  :disabled="isBusy"
                  @click="createAndOpenDocument()"
                >
                  <template #icon>
                    <NIcon :size="14"><Plus /></NIcon>
                  </template>
                </NButton>
              </template>
              新建页面
            </NTooltip>
          </NButtonGroup>
        </div>

        <div v-if="sidebarView === 'documents'" class="document-list">
          <div v-for="group in articleGroups" :key="group.id" class="document-group">
            <div
              class="document-list__item document-list__item--group"
              :class="{
                'document-list__item--active': selectedGroupId === group.id,
                'document-list__item--drop-available': canDropArticleIntoGroup(group.id),
                'document-list__item--drop-target': dropTargetGroupId === group.id,
              }"
              @dragenter.stop.prevent="handleGroupDragOver($event, group.id)"
              @dragover.stop.prevent="handleGroupDragOver($event, group.id)"
              @dragleave="handleGroupDragLeave($event, group.id)"
              @drop.stop.prevent="handleGroupDrop($event, group.id)"
            >
              <button
                type="button"
                class="document-list__select"
                :disabled="isBusy"
                @click="toggleGroup(group.id)"
              >
                <ChevronRight v-if="isGroupCollapsed(group.id)" :size="14" />
                <ChevronDown v-else :size="14" />
                <Folder v-if="isGroupCollapsed(group.id)" :size="16" />
                <FolderOpen v-else :size="16" />
                <span class="document-list__main">
                  <span class="document-list__title">{{ displayTitle(group) }}</span>
                  <span class="document-list__meta"
                    >{{ getGroupArticleCount(group.id) }} 个页面</span
                  >
                </span>
              </button>
              <span class="document-list__actions document-list__actions--menu">
                <span v-if="canDropArticleIntoGroup(group.id)" class="document-list__drop-hint">
                  放入此分组
                </span>
                <NTooltip trigger="hover">
                  <template #trigger>
                    <NButton
                      class="document-list__more"
                      size="tiny"
                      quaternary
                      :aria-label="`${displayTitle(group)}中新建页面`"
                      :disabled="isBusy"
                      @click.stop="createAndOpenDocument(group.id)"
                    >
                      <template #icon>
                        <NIcon :size="14"><Plus /></NIcon>
                      </template>
                    </NButton>
                  </template>
                  新建页面
                </NTooltip>
                <DropdownMenuRoot>
                  <DropdownMenuTrigger as-child>
                    <NButton
                      class="document-list__more"
                      size="tiny"
                      quaternary
                      :aria-label="`${displayTitle(group)}更多操作`"
                      :disabled="isBusy"
                      @click.stop
                    >
                      <template #icon
                        ><NIcon :size="15"><Ellipsis /></NIcon
                      ></template>
                    </NButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuContent class="document-card-menu" align="end" :side-offset="5">
                      <DropdownMenuItem
                        class="document-card-menu__item"
                        @select="openDocumentProperties(group)"
                      >
                        <Info :size="14" />属性
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        class="document-card-menu__item"
                        @select="startRename(group)"
                      >
                        <Pencil :size="14" />重命名分组
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenuPortal>
                </DropdownMenuRoot>
              </span>
            </div>

            <SidebarDocumentTree
              v-if="!isGroupCollapsed(group.id)"
              :nodes="getGroupArticleNodes(group.id)"
              :current-document-id="currentDocumentId"
              :collapsed-document-ids="collapsedDocumentIds"
              :dragged-article-id="draggedArticleId"
              :busy="isBusy"
              :depth="1"
              @select="selectDocument"
              @toggle="toggleDocument"
              @create-child="createAndOpenDocument"
              @properties="openDocumentProperties"
              @rename="startRename"
              @delete="deleteDocument"
              @drag-start="handleArticleDragStart($event.event, $event.document)"
              @drag-end="handleArticleDragEnd"
            />
          </div>

          <p
            v-if="articleGroups.length > 0 && ungroupedArticleNodes.length > 0"
            class="document-list__subheading"
          >
            未分组
          </p>

          <SidebarDocumentTree
            :nodes="ungroupedArticleNodes"
            :current-document-id="currentDocumentId"
            :collapsed-document-ids="collapsedDocumentIds"
            :dragged-article-id="draggedArticleId"
            :busy="isBusy"
            @select="selectDocument"
            @toggle="toggleDocument"
            @create-child="createAndOpenDocument"
            @properties="openDocumentProperties"
            @rename="startRename"
            @delete="deleteDocument"
            @drag-start="handleArticleDragStart($event.event, $event.document)"
            @drag-end="handleArticleDragEnd"
          />

          <p
            v-if="articleGroups.length === 0 && ungroupedArticleNodes.length === 0"
            class="document-list__empty"
          >
            暂无文档
          </p>
        </div>

        <div v-if="sidebarView === 'trash'" class="document-list">
          <p class="sidebar-section-heading sidebar-section-heading--inline">回收站</p>
          <div v-for="document in deletedDocuments" :key="document.id" class="document-list__item">
            <button
              type="button"
              class="document-list__select"
              :disabled="isBusy"
              @click="restoreDocument(document)"
            >
              <Archive :size="16" />
              <span class="document-list__main">
                <span class="document-list__title">{{ displayTitle(document) }}</span>
                <span class="document-list__meta"
                  >删除于 {{ formatUpdatedAt(document.updatedAt) }}</span
                >
              </span>
            </button>
            <span class="document-list__actions">
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    size="tiny"
                    quaternary
                    circle
                    aria-label="恢复"
                    :disabled="isBusy"
                    @click.stop="restoreDocument(document)"
                  >
                    <template #icon>
                      <NIcon :size="14"><RotateCcw /></NIcon>
                    </template>
                  </NButton>
                </template>
                恢复
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    size="tiny"
                    quaternary
                    circle
                    aria-label="彻底删除"
                    :disabled="isBusy"
                    @click.stop="permanentlyDeleteDocument(document)"
                  >
                    <template #icon>
                      <NIcon :size="14"><Trash2 /></NIcon>
                    </template>
                  </NButton>
                </template>
                彻底删除
              </NTooltip>
            </span>
          </div>

          <p v-if="deletedDocuments.length === 0" class="document-list__empty">回收站为空</p>
        </div>

        <div class="sidebar-footer">
          <NButton
            class="market-link"
            :class="{ 'market-link--active': sidebarView === 'trash' }"
            quaternary
            @click="sidebarView = sidebarView === 'trash' ? 'documents' : 'trash'"
          >
            <template #icon>
              <NIcon :size="17"><Trash2 /></NIcon>
            </template>
            回收站
          </NButton>
        </div>
      </aside>

      <Transition name="settings-surface" mode="out-in">
        <SettingsPage
          v-if="showSettings"
          key="settings"
          :settings="appSettings"
          :ai-settings="aiSettings"
          :default-data-directory="defaultDataDirectory"
          :data-busy="isChangingDataDirectory"
          @change="updateSettings"
          @ai-change="updateAiSettings"
          @reset="resetSettings"
          @choose-data-directory="chooseDataDirectory"
          @restore-data-directory="restoreDefaultDataDirectory"
          @close="showSettings = false"
        />

        <div v-else key="document-workspace" class="document-workspace">
          <AiChatPanel
            v-if="showAiChat && aiChatFullscreen"
            v-model:prompt="aiPrompt"
            workspace
            :mode="aiChatMode"
            :mode-label="aiModeLabel"
            :mode-options="AI_MODE_OPTIONS"
            :provider-label="aiProviderLabel"
            :provider-options="AI_PROVIDER_OPTIONS"
            :reasoning-label="aiReasoningLabel"
            :reasoning-options="AI_REASONING_OPTIONS"
            :model-options="aiModelOptions"
            :settings="aiSettings"
            :messages="aiMessages"
            :prompt-placeholder="aiPromptPlaceholder"
            :error="aiError"
            :is-running="aiIsRunning"
            :render-markdown-message="renderMarkdownMessage"
            @select-mode="selectAiMode"
            @select-provider="selectAiProvider"
            @select-model="selectAiModel"
            @select-reasoning="selectAiReasoning"
            @toggle-workspace="setAiChatWorkspace"
            @close="closeAiChat"
            @run="runAiAssistant"
            @stop="stopAiAssistant"
            @clear="clearAiChat"
            @insert="insertAiMessage"
          />

          <section
            class="editor-panel"
            :class="{ 'editor-panel--behind-ai': showAiChat && aiChatFullscreen }"
            :aria-hidden="showAiChat && aiChatFullscreen"
          >
          <header class="topbar">
            <div class="topbar__title">
              <NInput
                v-model:value="documentTitle"
                class="topbar-title-input"
                :bordered="false"
                :disabled="isLoadingDocument || Boolean(loadError)"
                aria-label="文档标题"
                @update:value="handleTitleInput"
                @blur="commitCurrentTitle"
                @keydown.enter.prevent="commitCurrentTitle"
              />
            </div>

            <div class="topbar__actions">
              <div class="save-status" :class="saveStatusClass">
                <span class="save-status__dot" aria-hidden="true"></span>
                <span>{{ saveStatusText }}</span>
              </div>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    class="topbar__icon-button"
                    quaternary
                    circle
                    aria-label="新建子页面"
                    :disabled="isBusy || isLoadingDocument || !currentDocument"
                    @click="createAndOpenDocument(currentDocumentId)"
                  >
                    <template #icon>
                      <NIcon :size="20"><Plus /></NIcon>
                    </template>
                  </NButton>
                </template>
                新建子页面
              </NTooltip>
              <NButton
                class="topbar__text-button"
                text
                :loading="isPreparingShare"
                @click="openShareView"
              >
                分享
              </NButton>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    class="topbar__icon-button"
                    quaternary
                    circle
                    aria-label="插入图片"
                    :disabled="isLoadingDocument || Boolean(loadError)"
                    @click="editorShell?.insertImage()"
                  >
                    <template #icon>
                      <NIcon :size="20"><ImagePlus /></NIcon>
                    </template>
                  </NButton>
                </template>
                插入图片
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    class="topbar__icon-button"
                    quaternary
                    circle
                    aria-label="插入附件"
                    :disabled="isLoadingDocument || Boolean(loadError)"
                    @click="editorShell?.insertAttachment()"
                  >
                    <template #icon>
                      <NIcon :size="20"><Archive /></NIcon>
                    </template>
                  </NButton>
                </template>
                插入附件
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton class="topbar__icon-button" quaternary circle aria-label="评论">
                    <template #icon>
                      <NIcon :size="20"><MessageSquare /></NIcon>
                    </template>
                  </NButton>
                </template>
                评论
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton class="topbar__icon-button" quaternary circle aria-label="更多">
                    <template #icon>
                      <NIcon :size="20"><Ellipsis /></NIcon>
                    </template>
                  </NButton>
                </template>
                更多
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    class="topbar__icon-button"
                    quaternary
                    circle
                    aria-label="开发面板"
                    @click="showInspector = true"
                  >
                    <template #icon>
                      <NIcon :size="19"><Share2 /></NIcon>
                    </template>
                  </NButton>
                </template>
                开发面板
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    class="topbar__icon-button"
                    quaternary
                    circle
                    aria-label="搜索"
                    @click="openSearch"
                  >
                    <template #icon>
                      <NIcon :size="21"><Search /></NIcon>
                    </template>
                  </NButton>
                </template>
                搜索
              </NTooltip>
            </div>
          </header>

          <EditorShell
            ref="editorShell"
            :model-value="editorContent"
            :readonly="isLoadingDocument || Boolean(loadError)"
            :settings="appSettings"
            :internal-documents="internalDocuments"
            :document-id="currentDocumentId"
            @update:model-value="handleEditorContentUpdate"
            @text-update="handleTextUpdate"
            @image-error="message.error"
            @open-document="loadDocument"
          />
          </section>
        </div>
      </Transition>

      <aside v-if="!showAiChat" class="floating-help" aria-label="帮助入口">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton class="floating-help__button" circle aria-label="AI" @click="openAiChat">
              <template #icon>
                <NIcon :size="20"><Sparkles /></NIcon>
              </template>
            </NButton>
          </template>
          AI
        </NTooltip>
      </aside>

      <AiChatPanel
        v-if="showAiChat && !aiChatFullscreen"
        v-model:prompt="aiPrompt"
        :workspace="false"
        :mode="aiChatMode"
        :mode-label="aiModeLabel"
        :mode-options="AI_MODE_OPTIONS"
        :provider-label="aiProviderLabel"
        :provider-options="AI_PROVIDER_OPTIONS"
        :reasoning-label="aiReasoningLabel"
        :reasoning-options="AI_REASONING_OPTIONS"
        :model-options="aiModelOptions"
        :settings="aiSettings"
        :messages="aiMessages"
        :prompt-placeholder="aiPromptPlaceholder"
        :error="aiError"
        :is-running="aiIsRunning"
        :render-markdown-message="renderMarkdownMessage"
        @select-mode="selectAiMode"
        @select-provider="selectAiProvider"
        @select-model="selectAiModel"
        @select-reasoning="selectAiReasoning"
        @toggle-workspace="setAiChatWorkspace"
        @close="closeAiChat"
        @run="runAiAssistant"
        @stop="stopAiAssistant"
        @clear="clearAiChat"
        @insert="insertAiMessage"
      />

      <section
        v-if="false"
        class="ai-chat-popover"
        aria-label="AI 聊天"
      >
        <header class="ai-chat-popover__header">
          <div class="ai-chat-popover__heading">
            <strong>AI Markdown 助手</strong>
            <span>{{ aiProviderLabel }} · {{ aiSettings.model }}</span>
          </div>
          <div class="ai-chat-popover__window-actions">
            <button
              type="button"
              class="ai-chat-popover__icon-button"
              :aria-label="aiChatFullscreen ? '还原悬浮 AI 聊天' : '在文档区打开 AI 聊天'"
              @click="setAiChatWorkspace(!aiChatFullscreen)"
            >
              <Minimize2 v-if="aiChatFullscreen" :size="15" />
              <Maximize2 v-else :size="15" />
            </button>
            <button
              type="button"
              class="ai-chat-popover__icon-button"
              aria-label="关闭 AI 聊天"
              @click="closeAiChat"
            >
              <X :size="16" />
            </button>
          </div>
        </header>

        <div class="ai-chat-popover__messages" aria-live="polite">
          <p v-if="aiMessages.length === 0" class="ai-chat-popover__empty">
            Ask 会在这里流式回答；Edit 会把完整 Markdown 块同步写入当前文档。
          </p>
          <article
            v-for="chatMessage in aiMessages"
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
                @click="insertAiMessage(chatMessage.content)"
              >
                插入
              </button>
              <span v-else>已同步到文档</span>
              <span v-if="chatMessage.status === 'streaming'">输出中</span>
            </footer>
          </article>
        </div>

        <p v-if="aiError" class="ai-chat-popover__error">{{ aiError }}</p>

        <form class="ai-chat-composer" @submit.prevent="runAiAssistant">
          <div class="ai-chat-composer__toolbar" aria-label="AI 输入选项">
            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector ai-chat-selector--primary">
                  <span>{{ aiModeLabel }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="ai-chat-menu" align="start" :side-offset="6">
                  <DropdownMenuItem
                    v-for="option in AI_MODE_OPTIONS"
                    :key="option.value"
                    class="ai-chat-menu__item"
                    :class="{ 'ai-chat-menu__item--active': aiChatMode === option.value }"
                    @select="selectAiMode(option.value)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ option.label }}</strong>
                      <small>{{ option.description }}</small>
                    </span>
                    <Check v-if="aiChatMode === option.value" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector">
                  <span>{{ aiProviderLabel }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="ai-chat-menu" align="start" :side-offset="6">
                  <DropdownMenuItem
                    v-for="option in AI_PROVIDER_OPTIONS"
                    :key="option.value"
                    class="ai-chat-menu__item"
                    :class="{ 'ai-chat-menu__item--active': aiSettings.provider === option.value }"
                    @select="selectAiProvider(option.value)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ option.label }}</strong>
                      <small>{{ option.description }}</small>
                    </span>
                    <Check v-if="aiSettings.provider === option.value" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector ai-chat-selector--model">
                  <span>{{ aiSettings.model }}</span>
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
                    v-for="model in aiModelOptions"
                    :key="model"
                    class="ai-chat-menu__item"
                    :class="{ 'ai-chat-menu__item--active': aiSettings.model === model }"
                    @select="selectAiModel(model)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ model }}</strong>
                      <small
                        v-if="!getAiProviderConfig(aiSettings.provider).models.includes(model)"
                      >
                        当前自定义模型
                      </small>
                    </span>
                    <Check v-if="aiSettings.model === model" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>

            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <button type="button" class="ai-chat-selector">
                  <span>{{ aiReasoningLabel }}</span>
                  <ChevronDown :size="13" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="ai-chat-menu" align="start" :side-offset="6">
                  <DropdownMenuItem
                    v-for="option in AI_REASONING_OPTIONS"
                    :key="option.value"
                    class="ai-chat-menu__item"
                    :class="{
                      'ai-chat-menu__item--active': aiSettings.reasoningEffort === option.value,
                    }"
                    @select="selectAiReasoning(option.value)"
                  >
                    <span class="ai-chat-menu__item-copy">
                      <strong>{{ option.label }}</strong>
                      <small>{{ option.description }}</small>
                    </span>
                    <Check v-if="aiSettings.reasoningEffort === option.value" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </div>
          <textarea
            v-model="aiPrompt"
            rows="3"
            :placeholder="aiPromptPlaceholder"
            aria-label="AI 输入"
            @keydown.enter.exact.prevent="runAiAssistant"
          ></textarea>
          <div class="ai-chat-composer__actions">
            <button
              type="button"
              :disabled="aiMessages.length === 0 && !aiError"
              @click="clearAiChat"
            >
              清空
            </button>
            <button v-if="aiIsRunning" type="button" @click="stopAiAssistant">停止</button>
            <button type="submit" :disabled="aiIsRunning || !aiPrompt.trim()">
              {{ aiChatMode === 'edit' ? '编辑' : '发送' }}
            </button>
          </div>
        </form>
      </section>

      <NDrawer v-model:show="showInspector" :width="380" placement="right">
        <NDrawerContent class="editor-inspector-content" title="开发面板" closable>
          <section v-if="visibleErrorMessage">
            <h2>Error</h2>
            <p>{{ visibleErrorMessage }}</p>
          </section>

          <section>
            <h2>Autosave</h2>
            <p>状态：{{ saveStatusText }}</p>
            <p>Revision：{{ revisionText }}</p>
          </section>

          <section>
            <h2>Text</h2>
            <p>{{ plainText || '空文档' }}</p>
          </section>

          <section>
            <h2>JSON</h2>
            <pre>{{ previewJson }}</pre>
          </section>
        </NDrawerContent>
      </NDrawer>

      <NModal
        v-model:show="showImportModal"
        preset="card"
        title="导入文档"
        class="import-modal"
        :bordered="false"
      >
        <div class="import-options" aria-label="导入格式">
          <button type="button" class="import-option-card" @click="chooseImportFormat('json')">
            <span class="import-option-card__icon">
              <FileText :size="22" />
            </span>
            <span class="import-option-card__content">
              <span class="import-option-card__title">JSON 格式</span>
              <span class="import-option-card__description">导入本软件导出的 JSON 文档</span>
            </span>
          </button>
          <button type="button" class="import-option-card" @click="chooseImportFormat('markdown')">
            <span class="import-option-card__icon">
              <Upload :size="22" />
            </span>
            <span class="import-option-card__content">
              <span class="import-option-card__title">Markdown 格式</span>
              <span class="import-option-card__description"
                >将 .md / .markdown 转换为本软件 JSON</span
              >
            </span>
          </button>
        </div>
      </NModal>

      <NModal
        v-model:show="showShareModal"
        preset="card"
        title="只读分享预览"
        class="share-modal"
        :bordered="false"
      >
        <div class="share-actions">
          <NButton secondary @click="exportCurrentDocument('markdown')">导出 Markdown</NButton>
          <NButton type="primary" @click="exportCurrentDocument('html')">导出 HTML</NButton>
        </div>
        <iframe class="share-preview" title="只读分享预览" sandbox="" :srcdoc="shareHtml"></iframe>
      </NModal>

      <NModal
        v-model:show="showSearchModal"
        preset="card"
        title="搜索笔记"
        class="search-modal"
        :bordered="false"
        @after-leave="searchQuery = ''"
      >
        <NInput
          v-model:value="searchQuery"
          autofocus
          clearable
          placeholder="搜索标题或正文"
          aria-label="搜索标题或正文"
          @keydown.enter.prevent="openFirstSearchResult"
        >
          <template #prefix>
            <NIcon :size="17"><Search /></NIcon>
          </template>
        </NInput>

        <div v-if="searchQuery.trim()" class="search-results" role="listbox" aria-label="搜索结果">
          <button
            v-for="document in searchResults"
            :key="document.id"
            type="button"
            class="search-results__item"
            @click="openSearchResult(document)"
          >
            <Folder v-if="document.documentKind === 'group'" :size="17" />
            <FileText v-else :size="17" />
            <span class="search-results__content">
              <span class="search-results__title">{{ displayTitle(document) }}</span>
              <span class="search-results__snippet">{{ getSearchSnippet(document) }}</span>
            </span>
          </button>
          <p v-if="searchResults.length === 0" class="search-results__empty">没有找到匹配的笔记</p>
        </div>
        <p v-else class="search-results__hint">输入关键词搜索标题和正文，按 Enter 打开首条结果。</p>
      </NModal>

      <NModal
        v-model:show="showPropertiesModal"
        preset="card"
        :title="propertiesDocument ? `${displayTitle(propertiesDocument)} · 属性` : '属性'"
        class="document-properties-modal"
        :bordered="false"
        @after-leave="resetPropertiesState"
      >
        <dl v-if="propertiesDocument" class="document-properties">
          <div class="document-properties__row">
            <dt>类型</dt>
            <dd>{{ propertiesDocument.documentKind === 'group' ? '分组' : '页面' }}</dd>
          </div>
          <div
            v-if="propertiesDocument.documentKind === 'article'"
            class="document-properties__row"
          >
            <dt>上级位置</dt>
            <dd>{{ documentParentTitle(propertiesDocument) }}</dd>
          </div>
          <div v-else class="document-properties__row">
            <dt>页面数量</dt>
            <dd>{{ getGroupArticleCount(propertiesDocument.id) }} 个</dd>
          </div>
          <div
            v-if="propertiesDocument.documentKind === 'article'"
            class="document-properties__row"
          >
            <dt>字符数</dt>
            <dd>{{ documentCharacterCount(propertiesDocument) }}</dd>
          </div>
          <div class="document-properties__row document-properties__row--field">
            <dt>标签</dt>
            <dd>
              <NInput
                v-model:value="propertiesDraftTags"
                placeholder="用逗号、顿号或换行分隔标签"
                aria-label="标签"
              />
            </dd>
          </div>
          <div class="document-properties__row document-properties__row--field">
            <dt>来源 URL</dt>
            <dd>
              <NInput
                v-model:value="propertiesDraftSourceUrl"
                placeholder="https://..."
                aria-label="来源 URL"
              />
            </dd>
          </div>
          <div class="document-properties__row document-properties__row--field">
            <dt>作者</dt>
            <dd>
              <NInput
                v-model:value="propertiesDraftAuthor"
                placeholder="作者或机构"
                aria-label="作者"
              />
            </dd>
          </div>
          <div class="document-properties__row document-properties__row--field">
            <dt>说明</dt>
            <dd>
              <textarea
                v-model="propertiesDraftDescription"
                class="document-properties__textarea"
                rows="3"
                placeholder="补充来源、用途、摘要或归档备注"
                aria-label="说明"
              ></textarea>
            </dd>
          </div>
          <div class="document-properties__row">
            <dt>创建时间</dt>
            <dd>{{ formatDocumentDateTime(propertiesDocument.createdAt) }}</dd>
          </div>
          <div class="document-properties__row">
            <dt>最后修改</dt>
            <dd>{{ formatDocumentDateTime(propertiesDocument.updatedAt) }}</dd>
          </div>
        </dl>
        <template #footer>
          <NButton @click="showPropertiesModal = false">取消</NButton>
          <NButton type="primary" :loading="isSavingProperties" @click="saveDocumentProperties">
            保存属性
          </NButton>
        </template>
      </NModal>

      <NModal
        v-model:show="showRenameModal"
        preset="card"
        :title="renamingDocument?.documentKind === 'group' ? '重命名分组' : '重命名页面'"
        class="rename-modal"
        :bordered="false"
        @after-leave="resetRenameState"
      >
        <NInput
          v-model:value="renameTitle"
          autofocus
          maxlength="80"
          show-count
          placeholder="输入新名称"
          aria-label="新名称"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
        />
        <template #footer>
          <div class="modal-actions">
            <NButton @click="cancelRename">取消</NButton>
            <NButton type="primary" :loading="isBusy" @click="commitRename">保存</NButton>
          </div>
        </template>
      </NModal>

      <NModal
        v-model:show="showCreateGroupModal"
        preset="card"
        title="新建分组"
        class="create-group-modal"
        :bordered="false"
      >
        <NInput
          v-model:value="newGroupTitle"
          autofocus
          placeholder="输入分组名称"
          @keydown.enter.prevent="confirmCreateGroup"
        />
        <template #footer>
          <div class="modal-actions">
            <NButton @click="showCreateGroupModal = false">取消</NButton>
            <NButton type="primary" :disabled="isBusy" @click="confirmCreateGroup">创建</NButton>
          </div>
        </template>
      </NModal>
    </section>
  </main>
</template>
