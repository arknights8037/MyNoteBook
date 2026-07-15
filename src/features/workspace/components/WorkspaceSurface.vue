<script setup lang="ts">
import { Sparkles } from '@lucide/vue'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import NButton from '@/ui/NButton.vue'
import NIcon from '@/ui/NIcon.vue'
import NTooltip from '@/ui/NTooltip.vue'
import { useDialog, useMessage } from '@/ui/services'

import { useAiConversation } from '@/composables/useAiConversation'
import { useAgentRun } from '@/composables/useAgentRun'
import { useAgentPatchWorkflow } from '@/composables/useAgentPatchWorkflow'
import { useDocumentWorkspace } from '@/composables/useDocumentWorkspace'
import { useSensitiveAuthorization } from '@/composables/useSensitiveAuthorization'
import { useDocumentSearch } from '@/composables/useDocumentSearch'
import { useWorkspaceSurface } from '@/composables/useWorkspaceSurface'
import { useDataDirectorySettings } from '@/composables/useDataDirectorySettings'
import { useAiPreferences } from '@/composables/useAiPreferences'
import { useHomeKeyboardShortcuts } from '@/composables/useHomeKeyboardShortcuts'
import { ensureTopLevelBlockIds } from '@/editor/blockId'
import { parseEditorContentJson } from '@/editor/editorContent'
import { EMPTY_TIPTAP_DOCUMENT, type DocumentId, type DocumentSummary } from '@/models/document'
import { AI_PROVIDER_CONFIGS } from '@/models/ai'
import { AI_MODE_OPTIONS } from '@/models/aiChatMode'
import type { AgentTask } from '@/models/agent'
import { createEntityId } from '@/models/id'
import {
  createDefaultAppSettings,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from '@/models/settings'
import type { DocumentService } from '@/services/DocumentService'
import type { DocumentTransferService } from '@/services/DocumentTransferService'
import type { AutomationService } from '@/services/AutomationService'
import type { KnowledgeControlService } from '@/services/KnowledgeControlService'
import type { AuditRepository } from '@/repositories/AuditRepository'
import type { RegexReplaceExecutor } from '@/services/AgentCommandService'
import { renderAiMarkdown } from '@/services/AiMarkdownRenderer'
import { applyTheme, setThemePreference, subscribeToSystemTheme } from '@/services/theme'
import DocumentSidebar, {
  type SidebarView,
} from '@/features/documents/components/DocumentSidebar.vue'
import AgentAuthorizationModal from './home/AgentAuthorizationModal.vue'
import {
  displayDocumentTitle,
  formatDocumentTimestamp,
  normalizeDocumentTitle,
} from '@/features/documents/documentPresentation'
import EditorTopbar from './home/EditorTopbar.vue'
import LazySurfaceLoader from './home/LazySurfaceLoader.vue'
import type { DocumentSidebarExpose, EditorShellExpose } from './home/homePageTypes'
import { useDocumentTransferActions } from './home/useDocumentTransferActions'
import { useHomeAiMessageActions } from './home/useHomeAiMessageActions'
import { CREATE_VIEW_TEMPLATES, type CreateViewKind } from './home/viewTemplates'

const EditorShell = defineAsyncComponent({
  loader: () => import('@/editor/EditorShell.vue'),
  loadingComponent: LazySurfaceLoader,
  delay: 80,
  suspensible: false,
})
const SettingsSurface = defineLazySurface(
  () => import('@/features/settings/components/SettingsSurface.vue'),
)
const AiChatPanel = defineLazySurface(() => import('@/features/ai-chat/components/AiChatPanel.vue'))
const PluginSkillsSurface = defineLazySurface(
  () => import('@/features/integrations/skills/components/PluginSkillsSurface.vue'),
)
const AutomationSurface = defineLazySurface(
  () => import('@/features/automation/components/AutomationSurface.vue'),
)
const AuditSurface = defineLazySurface(() => import('@/features/audit/components/AuditSurface.vue'))
const KnowledgeControlSurface = defineLazySurface(
  () => import('@/features/knowledge-control/components/KnowledgeControlSurface.vue'),
)
const AgentPatchReviewModal = defineLazyComponent(() => import('./home/AgentPatchReviewModal.vue'))
const CreateViewModal = defineLazyComponent(() => import('./home/CreateViewModal.vue'))
const DeveloperInspectorDrawer = defineLazyComponent(
  () => import('./home/DeveloperInspectorDrawer.vue'),
)
const DocumentNameModals = defineLazyComponent(() => import('./home/DocumentNameModals.vue'))
const DocumentPropertiesModal = defineLazyComponent(
  () => import('./home/DocumentPropertiesModal.vue'),
)
const DocumentSearchModal = defineLazyComponent(() => import('./home/DocumentSearchModal.vue'))
const ImportDocumentModal = defineLazyComponent(() => import('./home/ImportDocumentModal.vue'))
const SensitiveAuthorizationModal = defineLazyComponent(
  () => import('./home/SensitiveAuthorizationModal.vue'),
)
const SharePreviewModal = defineLazyComponent(() => import('./home/SharePreviewModal.vue'))

const dependencies = defineProps<{
  createDocumentService: () => Promise<DocumentService>
  getDocumentTransferService: () => Promise<DocumentTransferService>
  getAuditRepository: () => Promise<AuditRepository>
  getAutomationService: () => Promise<AutomationService>
  getKnowledgeControlService: () => Promise<KnowledgeControlService>
  replaceBlocksByRegex: RegexReplaceExecutor
}>()

function defineLazySurface(loader: () => Promise<unknown>) {
  return defineAsyncComponent({
    loader: loader as () => Promise<{ default: never }>,
    loadingComponent: LazySurfaceLoader,
    delay: 80,
    suspensible: false,
  })
}

function defineLazyComponent(loader: () => Promise<unknown>) {
  return defineAsyncComponent({
    loader: loader as () => Promise<{ default: never }>,
    suspensible: false,
  })
}

const createDocumentId = (): DocumentId => createEntityId('doc')

const editorShell = ref<EditorShellExpose | null>(null)
const documentSidebar = ref<DocumentSidebarExpose | null>(null)
const sidebarView = ref<SidebarView>('documents')
const showInspector = ref(false)
const showImportModal = ref(false)
const showShareModal = ref(false)
const showCreateViewModal = ref(false)
const {
  showAiChat,
  aiChatFullscreen,
  showSettings,
  showPluginSkills,
  showAutomations,
  showAudit,
  showKnowledgeControl,
  activeSurface,
  openAgentWorkspace,
  openSettingsSurface,
  openPluginSkillsSurface,
  openAutomationsSurface,
  openAuditSurface,
  openKnowledgeControlSurface,
  openDocumentSurface,
  closeAiChat,
  setAiChatWorkspace,
} = useWorkspaceSurface()
const appSettings = ref<AppSettings>(loadAppSettings())
const editorSettings = computed<AppSettings>(() =>
  showAiChat.value && !aiChatFullscreen.value && appSettings.value.jumpAid === 'outline'
    ? { ...appSettings.value, jumpAid: 'anchors' }
    : appSettings.value,
)
const {
  showSensitiveAuthModal,
  sensitiveAuthTitle,
  sensitiveAuthDescription,
  sensitiveAuthPassword,
  sensitiveAuthError,
  requestSensitiveAuthorization,
  confirmSensitiveAuthorization,
  cancelSensitiveAuthorization,
} = useSensitiveAuthorization(appSettings)
const aiError = ref('')
const {
  aiSettings,
  aiChatMode,
  aiModeLabel,
  aiProviderLabel,
  aiReasoningLabel,
  aiPromptPlaceholder,
  aiModelOptions,
  reasoningOptions: AI_REASONING_OPTIONS,
  updateAiSettings,
  selectAiMode,
  selectAiProvider,
  selectAiModel,
  selectAiReasoning,
  resetAiSettings,
  ensureAiSecretLoaded,
} = useAiPreferences(aiError)
const aiIsRunning = ref(false)
const agentTasks = ref<AgentTask[]>([])
const dialog = useDialog()
const message = useMessage()
const documentWorkspace = useDocumentWorkspace({
  settings: appSettings,
  createService: dependencies.createDocumentService,
  editor: editorShell,
  createId: createDocumentId,
  notify: message,
  authorize: requestSensitiveAuthorization,
  openDocumentSurface,
  confirmDelete: confirmDocumentRemoval,
})
const { state: documentState, lifecycle, metadata, tree, trash } = documentWorkspace
const {
  editorContent,
  plainText,
  documentTitle,
  currentDocumentId,
  currentDocument,
  documents,
  deletedDocuments,
  selectedGroupId,
  isLoadingDocument,
  isBusy,
  loadError,
  actionError,
} = documentState
const {
  documentService,
  autosave,
  collapsedGroupIds,
  collapsedDocumentIds,
  mergeDocument: mergeDocumentIntoLists,
  removeDocuments: removeDocumentsFromLists,
  toggleGroup,
  toggleDocument,
  expandDocument,
  expandGroup,
  getGroupArticleCount,
  getActiveGroupId,
  runDocumentAction,
  requireDocumentService,
} = documentWorkspace
const {
  initialize: initializeDocuments,
  create: createDocument,
  createAndOpen: createAndOpenDocument,
  createAndOpenFromContent: createAndOpenDocumentFromContent,
  load: loadDocument,
  select: selectDocument,
  onEditorContentUpdate: handleEditorContentUpdate,
  onTextUpdate: handleTextUpdate,
  onTitleInput: handleTitleInput,
} = lifecycle
const { rename, properties, commitCurrentTitle } = metadata
const {
  document: renamingDocument,
  title: renameTitle,
  show: showRenameModal,
  start: startRename,
  cancel: cancelRename,
  reset: resetRenameState,
  commit: commitRename,
} = rename
const {
  document: propertiesDocument,
  show: showPropertiesModal,
  tags: propertiesDraftTags,
  sourceUrl: propertiesDraftSourceUrl,
  author: propertiesDraftAuthor,
  description: propertiesDraftDescription,
  saving: isSavingProperties,
  open: openDocumentProperties,
  reset: resetPropertiesState,
  save: saveDocumentProperties,
} = properties
const { groups, dragDrop } = tree
const {
  title: newGroupTitle,
  showCreate: showCreateGroupModal,
  create: createGroup,
  confirmCreate: confirmCreateGroup,
} = groups
const {
  draggedArticleId,
  dropTargetGroupId,
  start: handleArticleDragStart,
  end: handleArticleDragEnd,
  dragOverGroup: handleGroupDragOver,
  dragLeaveGroup: handleGroupDragLeave,
  dropOnGroup: handleGroupDrop,
} = dragDrop
const {
  delete: deleteDocument,
  restore: restoreWorkspaceDocument,
  permanentlyDelete: permanentlyDeleteDocument,
} = trash
const {
  pendingAgentTask,
  pendingAgentPatchSet,
  pendingAgentPatches,
  pendingAgentAcceptedPatches,
  showAgentPatchModal,
  isApplyingAgentPatches,
  lastAppliedAgentTask,
  lastAppliedPatchSet,
  restoreForDocument: restoreAgentStateForDocument,
  toggleAgentPatchAccepted,
  updateAgentPatchAfter,
  setAllPendingAgentPatchesAccepted,
  acceptAllPendingAgentPatches,
  rejectPendingAgentPatches,
  applyPendingAgentPatches,
  rollbackLastAgentTask,
  getAgentRepository,
  updateAgentTaskPersistence,
} = useAgentPatchWorkflow({
  error: aiError,
  tasks: agentTasks,
  notify: message,
  createTransactionId: createDocumentId,
  document: {
    getSnapshot: () => ({
      id: currentDocumentId.value,
      content: editorContent.value,
      dirty: autosave.dirty.value,
      revision: autosave.revision.value,
      blocks: editorShell.value?.getCurrentDocumentBlocks() ?? [],
    }),
    applyDocument: (document) => {
      editorContent.value = ensureTopLevelBlockIds(parseEditorContentJson(document.contentJson))
      plainText.value = document.plainText
      autosave.resetSavedState(document.revision)
    },
    mergeDocument: mergeDocumentIntoLists,
    removeDocument: (documentId) => removeDocumentsFromLists([documentId]),
  },
})
const activeAgentTask = computed(
  () => agentTasks.value.find((task) => task.status === 'running') ?? pendingAgentTask.value,
)
const aiConversation = useAiConversation({
  settings: aiSettings,
  mode: aiChatMode,
  error: aiError,
  isRunning: aiIsRunning,
  createId: createDocumentId,
  stop: stopAiAssistant,
  notify: (content) => message.success(content),
})
const aiMessages = aiConversation.messages
const aiPrompt = aiConversation.prompt
const aiChatHistory = aiConversation.history
const agentRun = useAgentRun({
  settings: aiSettings,
  mode: aiChatMode,
  prompt: aiPrompt,
  messages: aiMessages,
  error: aiError,
  isRunning: aiIsRunning,
  tasks: agentTasks,
  ensureSecretLoaded: ensureAiSecretLoaded,
  createId: createDocumentId,
  replaceBlocksByRegex: dependencies.replaceBlocksByRegex,
  notify: message,
  document: {
    captureSnapshot: () => ({
      id: currentDocumentId.value,
      title: documentTitle.value,
      tags: [...(currentDocument.value?.tags ?? [])],
      sourceUrl: currentDocument.value?.sourceUrl ?? '',
      author: currentDocument.value?.author ?? '',
      text: editorShell.value?.getText() || plainText.value,
      revision: autosave.revision.value,
      blocks: editorShell.value?.getCurrentDocumentBlocks() ?? [],
      selectedBlocks: editorShell.value?.getSelectedBlocks() ?? [],
      hasBlockSelection: editorShell.value?.hasBlockSelection() ?? false,
      documents: documents.value,
    }),
    flushBeforeEdit: async () => {
      const result = await autosave.flushBeforeDocumentChange()
      return { ok: result.ok, revision: autosave.revision.value }
    },
    searchDocuments: async (query, limit) => {
      const result = await requireDocumentService().searchKnowledgeDocuments(query, limit)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    readDocument: async (documentId) => {
      const result = await requireDocumentService().getDocument(documentId)
      return result.ok ? result.value : null
    },
    listDocumentBlocks: async (documentId) => {
      const result = await requireDocumentService().listDocumentBlocks(documentId)
      return result.ok ? result.value : []
    },
  },
  patches: {
    pendingTask: pendingAgentTask,
    pendingPatchSet: pendingAgentPatchSet,
    showModal: showAgentPatchModal,
    getRepository: getAgentRepository,
    updateTaskPersistence: updateAgentTaskPersistence,
  },
})
const agentRuntimeState = agentRun.runtimeState
let unsubscribeSystemTheme: (() => void) | null = null
const {
  defaultDataDirectory,
  isChangingDataDirectory,
  initializeDefaultDataDirectory,
  chooseDataDirectory,
  restoreDefaultDataDirectory,
} = useDataDirectorySettings({
  settings: appSettings,
  documentService,
  autosave,
  requestAuthorization: requestSensitiveAuthorization,
  initializeDocuments,
  message,
})

const {
  shareHtml,
  isPreparingShare,
  importFileAccept,
  openImportDialog: importDocumentFile,
  chooseImportFormat,
  handleImportFileChange,
  openShareView,
  exportCurrentDocument,
} = useDocumentTransferActions({
  getDocumentTransfer: dependencies.getDocumentTransferService,
  documentSidebar,
  editor: editorShell,
  editorContent,
  documentTitle,
  currentDocument,
  autosave,
  actionError,
  showImportModal,
  showShareModal,
  authorize: requestSensitiveAuthorization,
  runDocumentAction,
  createDocument,
  loadDocument,
  getActiveGroupId,
  normalizeTitle: normalizeDocumentTitle,
  notify: message,
})

const previewJson = computed(() =>
  JSON.stringify(editorContent.value ?? EMPTY_TIPTAP_DOCUMENT, null, 2),
)
const internalDocuments = computed(() =>
  documents.value
    .filter(
      (document) => document.documentKind === 'article' && document.id !== currentDocumentId.value,
    )
    .map((document) => ({ id: document.id, title: displayTitle(document) })),
)
const knowledgeDocumentCount = computed(
  () => documents.value.filter((document) => document.documentKind === 'article').length,
)
const visibleErrorMessage = computed(
  () =>
    loadError.value?.message ?? actionError.value?.message ?? autosave.error.value?.message ?? '',
)
const revisionText = computed(() => autosave.revision.value?.toString() ?? '-')
const saveStatusClass = computed(() => `save-status--${autosave.status.value}`)

const {
  showSearchModal,
  searchQuery,
  searchResults,
  isSearching,
  openSearch,
  closeSearch,
  getSearchSnippet,
} = useDocumentSearch({
  documents,
  getGroupArticleCount,
  searchDocuments: async (query, limit) => {
    if (!documentService.value) return []
    const result = await documentService.value.searchKnowledgeDocuments(query, limit)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  },
  onOpen: () => {
    sidebarView.value = 'documents'
  },
})
const { handleGlobalKeydown, handleDeveloperToolKeydown } = useHomeKeyboardShortcuts(appSettings, {
  search: openSearch,
  newDocument: () => {
    const parentId =
      appSettings.value.newDocumentLocation === 'current' ? currentDocumentId.value : null
    void createAndOpenDocument(parentId)
  },
  save: () => void autosave.flush(),
  openSettings: openSettingsSurface,
  importDocument: importDocumentFile,
})

const saveStatusText = computed(() => {
  if (isLoadingDocument.value) return '正在加载'
  if (loadError.value) return '加载失败'
  if (autosave.status.value === 'saved') return '已保存'
  if (autosave.status.value === 'dirty') return '有未保存更改'
  if (autosave.status.value === 'saving') return '正在保存'
  return '保存失败'
})

let hasInitializedDocuments = false

onMounted(async () => {
  globalThis.performance.mark('notebook:home-mounted')
  globalThis.addEventListener('keydown', handleDeveloperToolKeydown, true)
  globalThis.addEventListener('keydown', handleGlobalKeydown)
  unsubscribeSystemTheme = subscribeToSystemTheme(syncTheme)

  // Documents are the startup-critical path. Native secret and path services can be slow on
  // some Windows installations, so they must not hold the file tree behind an empty screen.
  await initializeDocuments()
  hasInitializedDocuments = true
  globalThis.performance.mark('notebook:documents-ready')
  if (import.meta.env.DEV) {
    const marks = globalThis.performance
      .getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('notebook:'))
      .map((entry) => `${entry.name}=${Math.round(entry.startTime)}ms`)
    globalThis.console.info(`[startup] ${marks.join(', ')}`)
  }
  void restoreAgentStateForDocument(currentDocumentId.value, { markInterrupted: true })
  void initializeDefaultDataDirectory()
})

onBeforeUnmount(() => {
  globalThis.removeEventListener('keydown', handleDeveloperToolKeydown, true)
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
  currentDocumentId,
  (documentId, previousDocumentId) => {
    if (hasInitializedDocuments && documentId && documentId !== previousDocumentId) {
      void restoreAgentStateForDocument(documentId)
    }
  },
  { flush: 'sync' },
)

function updateSettings(settings: AppSettings): void {
  appSettings.value = settings
}

function resetSettings(): void {
  const defaults = createDefaultAppSettings()
  appSettings.value = { ...defaults, dataDirectory: appSettings.value.dataDirectory }
  resetAiSettings()
  message.success('已恢复默认设置')
}

function syncTheme(): void {
  setThemePreference(appSettings.value.theme)
  applyTheme(appSettings.value.theme)
  globalThis.document.documentElement.dataset.reduceMotion = String(appSettings.value.reduceMotion)
}

async function runAiAssistant(): Promise<void> {
  await agentRun.run()
}

function stopAiAssistant(): void {
  agentRun.stop()
}

function answerAgentAuthorization(requestId: string, answer: string): void {
  if (!agentRun.answerAuthorization(requestId, answer)) {
    message.error('这个授权问题已失效，请等待 Agent 的最新状态')
  }
}

const {
  openChat: openAiChat,
  retryMessage: retryAiChatMessage,
  insertMessage: insertAiMessage,
  openSourceDocument: openAiSourceDocument,
  openEditorDocument,
  copyMessage: copyAiMessage,
  writeMessageToChildDocument: writeAiMessageToChildDocument,
  selectHistory: selectAiChatHistory,
} = useHomeAiMessageActions({
  conversation: aiConversation,
  showChat: showAiChat,
  editor: editorShell,
  currentDocumentId,
  autosave,
  actionError,
  runAssistant: runAiAssistant,
  runDocumentAction,
  selectDocument,
  createDocument,
  loadDocument,
  expandDocument,
  notify: message,
})

function clearAiChat(): void {
  agentRun.resetRuntime()
  aiConversation.clear()
}
const forkAiChatAtMessage = aiConversation.forkAtMessage
const editAiChatMessage = aiConversation.editMessage

const deleteAiChatHistory = aiConversation.deleteHistory

const renderMarkdownMessage = renderAiMarkdown

async function createAndOpenView(kind: CreateViewKind): Promise<void> {
  const template = CREATE_VIEW_TEMPLATES[kind]
  const { parseMarkdownDocument } = await import('@/editor/markdownImport')
  const parsed = parseMarkdownDocument(template.markdown, template.title)
  showCreateViewModal.value = false

  await createAndOpenDocumentFromContent(template.title, {
    content: parsed.content,
    plainText: parsed.plainText,
  })
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

async function restoreDocument(document: DocumentSummary): Promise<void> {
  sidebarView.value = 'documents'
  await restoreWorkspaceDocument(document)
}

function confirmDocumentRemoval(
  document: DocumentSummary,
  descendantCount: number,
  permanent: boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    dialog.warning({
      title: permanent ? '彻底删除页面' : '删除页面',
      content: permanent
        ? descendantCount > 0
          ? `彻底删除「${displayTitle(document)}」及其 ${descendantCount} 个子页面？此操作无法恢复。`
          : `彻底删除「${displayTitle(document)}」？此操作无法恢复。`
        : descendantCount > 0
          ? `删除「${displayTitle(document)}」及其 ${descendantCount} 个子页面？可在回收站恢复。`
          : `删除「${displayTitle(document)}」？可在回收站恢复。`,
      positiveText: permanent ? '彻底删除' : '删除',
      negativeText: '取消',
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

const displayTitle = displayDocumentTitle
const formatDocumentDateTime = formatDocumentTimestamp

function documentParentTitle(document: DocumentSummary): string {
  if (document.parentId === null) return '顶层页面'
  const parent = documents.value.find((candidate) => candidate.id === document.parentId)
  if (!parent) return '未知位置'
  return parent.documentKind === 'group'
    ? `分组 · ${displayTitle(parent)}`
    : `父页面 · ${displayTitle(parent)}`
}

function documentCharacterCount(document: DocumentSummary): number {
  return document.characterCount ?? Array.from(document.plainText.trim()).length
}
</script>

<template>
  <main class="app-shell">
    <section
      class="editor-workspace"
      :class="{
        'editor-workspace--ai-workspace': showAiChat && aiChatFullscreen,
        'editor-workspace--ai-docked': showAiChat && !aiChatFullscreen,
      }"
    >
      <DocumentSidebar
        ref="documentSidebar"
        v-model:view="sidebarView"
        :active-surface="activeSurface"
        :documents="documents"
        :deleted-documents="deletedDocuments"
        :current-document-id="currentDocumentId"
        :selected-group-id="selectedGroupId"
        :collapsed-group-ids="collapsedGroupIds"
        :collapsed-document-ids="collapsedDocumentIds"
        :dragged-article-id="draggedArticleId"
        :drop-target-group-id="dropTargetGroupId"
        :import-file-accept="importFileAccept"
        :busy="isBusy"
        @search="openSearch"
        @agent="openAgentWorkspace"
        @new-view="showCreateViewModal = true"
        @plugins="openPluginSkillsSurface"
        @automations="openAutomationsSurface"
        @audit="openAuditSurface"
        @knowledge="openKnowledgeControlSurface"
        @settings="openSettingsSurface"
        @import="importDocumentFile"
        @file-change="handleImportFileChange"
        @create-group="createGroup"
        @create-document="createAndOpenDocument"
        @toggle-group="toggleGroup"
        @select-document="selectDocument"
        @toggle-document="toggleDocument"
        @properties="openDocumentProperties"
        @rename="startRename"
        @delete="deleteDocument"
        @restore="restoreDocument"
        @permanently-delete="permanentlyDeleteDocument"
        @article-drag-start="handleArticleDragStart"
        @article-drag-end="handleArticleDragEnd"
        @group-drag-over="handleGroupDragOver"
        @group-drag-leave="handleGroupDragLeave"
        @group-drop="handleGroupDrop"
      />
      <Transition name="settings-surface" mode="out-in">
        <SettingsSurface
          v-if="showSettings"
          key="settings"
          :settings="appSettings"
          :ai-settings="aiSettings"
          :default-data-directory="defaultDataDirectory"
          :data-busy="isChangingDataDirectory"
          @change="updateSettings"
          @ai-change="updateAiSettings"
          @ai-section-open="ensureAiSecretLoaded"
          @reset="resetSettings"
          @choose-data-directory="chooseDataDirectory"
          @restore-data-directory="restoreDefaultDataDirectory"
          @close="showSettings = false"
        />

        <PluginSkillsSurface v-else-if="showPluginSkills" key="plugin-skills" />

        <AutomationSurface
          v-else-if="showAutomations"
          key="automations"
          :current-document-id="currentDocumentId"
          :current-document-title="documentTitle"
          :get-service="dependencies.getAutomationService"
        />

        <AuditSurface
          v-else-if="showAudit"
          key="audit"
          :get-repository="dependencies.getAuditRepository"
        />

        <KnowledgeControlSurface
          v-else-if="showKnowledgeControl"
          key="knowledge-control"
          :current-document-id="currentDocumentId"
          :current-document-revision="currentDocument?.revision ?? 0"
          :get-service="dependencies.getKnowledgeControlService"
        />

        <div
          v-else
          key="document-workspace"
          class="document-workspace"
          :class="{ 'document-workspace--agent-workspace': showAiChat && aiChatFullscreen }"
        >
          <AiChatPanel
            v-if="showAiChat && aiChatFullscreen"
            v-model:prompt="aiPrompt"
            workspace
            :mode="aiChatMode"
            :mode-label="aiModeLabel"
            :mode-options="AI_MODE_OPTIONS"
            :provider-label="aiProviderLabel"
            :provider-options="AI_PROVIDER_CONFIGS"
            :reasoning-label="aiReasoningLabel"
            :reasoning-options="AI_REASONING_OPTIONS"
            :model-options="aiModelOptions"
            :settings="aiSettings"
            :messages="aiMessages"
            :chat-history="aiChatHistory"
            :current-document-title="documentTitle"
            :knowledge-source-count="knowledgeDocumentCount"
            :prompt-placeholder="aiPromptPlaceholder"
            :error="aiError"
            :is-running="aiIsRunning"
            :agent-step="activeAgentTask?.currentStep ?? ''"
            :runtime-state="agentRuntimeState"
            :render-markdown-message="renderMarkdownMessage"
            @select-mode="selectAiMode"
            @select-provider="selectAiProvider"
            @select-model="selectAiModel"
            @select-reasoning="selectAiReasoning"
            @toggle-workspace="setAiChatWorkspace"
            @fork-message="forkAiChatAtMessage"
            @edit-message="editAiChatMessage"
            @retry-message="retryAiChatMessage"
            @select-history="selectAiChatHistory"
            @delete-history="deleteAiChatHistory"
            @close="closeAiChat"
            @run="runAiAssistant"
            @stop="stopAiAssistant"
            @clear="clearAiChat"
            @insert="insertAiMessage"
            @copy-message="copyAiMessage"
            @write-message-to-child="writeAiMessageToChildDocument"
            @open-source="openAiSourceDocument"
          />

          <section
            class="editor-panel"
            :class="{ 'editor-panel--behind-ai': showAiChat && aiChatFullscreen }"
            :aria-hidden="showAiChat && aiChatFullscreen"
          >
            <EditorTopbar
              v-model:title="documentTitle"
              :disabled="isLoadingDocument || Boolean(loadError)"
              :busy="isBusy"
              :has-document="Boolean(currentDocument)"
              :save-status-class="saveStatusClass"
              :save-status-text="saveStatusText"
              :preparing-share="isPreparingShare"
              @title-input="handleTitleInput"
              @commit-title="commitCurrentTitle"
              @create-child="createAndOpenDocument(currentDocumentId)"
              @share="openShareView"
              @insert-image="editorShell?.insertImage()"
              @insert-attachment="editorShell?.insertAttachment()"
              @inspect="showInspector = true"
              @search="openSearch"
            />

            <EditorShell
              ref="editorShell"
              :model-value="editorContent"
              :readonly="isLoadingDocument || Boolean(loadError)"
              :settings="editorSettings"
              :internal-documents="internalDocuments"
              :document-id="currentDocumentId"
              @update:model-value="handleEditorContentUpdate"
              @text-update="handleTextUpdate"
              @image-error="message.error"
              @open-document="openEditorDocument"
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
        docked
        :mode="aiChatMode"
        :mode-label="aiModeLabel"
        :mode-options="AI_MODE_OPTIONS"
        :provider-label="aiProviderLabel"
        :provider-options="AI_PROVIDER_CONFIGS"
        :reasoning-label="aiReasoningLabel"
        :reasoning-options="AI_REASONING_OPTIONS"
        :model-options="aiModelOptions"
        :settings="aiSettings"
        :messages="aiMessages"
        :chat-history="aiChatHistory"
        :current-document-title="documentTitle"
        :knowledge-source-count="knowledgeDocumentCount"
        :prompt-placeholder="aiPromptPlaceholder"
        :error="aiError"
        :is-running="aiIsRunning"
        :agent-step="activeAgentTask?.currentStep ?? ''"
        :runtime-state="agentRuntimeState"
        :render-markdown-message="renderMarkdownMessage"
        @select-mode="selectAiMode"
        @select-provider="selectAiProvider"
        @select-model="selectAiModel"
        @select-reasoning="selectAiReasoning"
        @toggle-workspace="setAiChatWorkspace"
        @fork-message="forkAiChatAtMessage"
        @edit-message="editAiChatMessage"
        @retry-message="retryAiChatMessage"
        @select-history="selectAiChatHistory"
        @delete-history="deleteAiChatHistory"
        @close="closeAiChat"
        @run="runAiAssistant"
        @stop="stopAiAssistant"
        @clear="clearAiChat"
        @insert="insertAiMessage"
        @copy-message="copyAiMessage"
        @write-message-to-child="writeAiMessageToChildDocument"
        @open-source="openAiSourceDocument"
      />

      <div
        v-if="lastAppliedPatchSet && lastAppliedAgentTask?.sessionId === currentDocumentId"
        class="agent-rollback-toast"
        role="status"
      >
        <span>最近一次 Agent 修改已写入，可撤销整次操作。</span>
        <NButton size="small" secondary @click="rollbackLastAgentTask">撤销</NButton>
      </div>

      <CreateViewModal
        v-if="showCreateViewModal"
        v-model:show="showCreateViewModal"
        @select="createAndOpenView"
      />

      <AgentPatchReviewModal
        v-if="pendingAgentTask && pendingAgentPatchSet"
        v-model:show="showAgentPatchModal"
        :workspace="aiChatFullscreen"
        :task="pendingAgentTask"
        :patch-set="pendingAgentPatchSet"
        :patches="pendingAgentPatches"
        :accepted-count="pendingAgentAcceptedPatches.length"
        :applying="isApplyingAgentPatches"
        @update-accepted="toggleAgentPatchAccepted"
        @update-after="updateAgentPatchAfter"
        @select-none="setAllPendingAgentPatchesAccepted(false)"
        @reject="rejectPendingAgentPatches"
        @accept-all="acceptAllPendingAgentPatches"
        @apply="applyPendingAgentPatches"
      />

      <DeveloperInspectorDrawer
        v-if="showInspector"
        v-model:show="showInspector"
        :error-message="visibleErrorMessage"
        :save-status="saveStatusText"
        :revision="revisionText"
        :plain-text="plainText"
        :preview-json="previewJson"
      />

      <SensitiveAuthorizationModal
        v-if="showSensitiveAuthModal"
        v-model:show="showSensitiveAuthModal"
        v-model:password="sensitiveAuthPassword"
        :title="sensitiveAuthTitle"
        :description="sensitiveAuthDescription"
        :error="sensitiveAuthError"
        @confirm="confirmSensitiveAuthorization"
        @cancel="cancelSensitiveAuthorization"
      />

      <AgentAuthorizationModal
        v-if="agentRuntimeState.authorizationRequest"
        :request="agentRuntimeState.authorizationRequest"
        @answer="answerAgentAuthorization"
        @cancel="stopAiAssistant"
      />

      <ImportDocumentModal
        v-if="showImportModal"
        v-model:show="showImportModal"
        @select="chooseImportFormat"
      />

      <SharePreviewModal
        v-if="showShareModal"
        v-model:show="showShareModal"
        :html="shareHtml"
        @export="exportCurrentDocument"
      />

      <DocumentSearchModal
        v-if="showSearchModal"
        v-model:show="showSearchModal"
        v-model:query="searchQuery"
        :results="searchResults"
        :searching="isSearching"
        :display-title="displayTitle"
        :get-snippet="getSearchSnippet"
        @open-first="openFirstSearchResult"
        @open="openSearchResult"
      />

      <DocumentPropertiesModal
        v-if="showPropertiesModal"
        v-model:show="showPropertiesModal"
        v-model:tags="propertiesDraftTags"
        v-model:source-url="propertiesDraftSourceUrl"
        v-model:author="propertiesDraftAuthor"
        v-model:description="propertiesDraftDescription"
        :document="propertiesDocument"
        :saving="isSavingProperties"
        :display-title="displayTitle"
        :parent-title="documentParentTitle"
        :group-article-count="getGroupArticleCount"
        :character-count="documentCharacterCount"
        :format-date-time="formatDocumentDateTime"
        @save="saveDocumentProperties"
        @reset="resetPropertiesState"
      />

      <DocumentNameModals
        v-if="showRenameModal || showCreateGroupModal"
        v-model:show-rename="showRenameModal"
        v-model:rename-title="renameTitle"
        v-model:show-create-group="showCreateGroupModal"
        v-model:group-title="newGroupTitle"
        :renaming-document="renamingDocument"
        :busy="isBusy"
        @commit-rename="commitRename"
        @cancel-rename="cancelRename"
        @reset-rename="resetRenameState"
        @create-group="confirmCreateGroup"
      />
    </section>
  </main>
</template>
