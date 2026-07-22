<script setup lang="ts">
import { Sparkles, X } from '@lucide/vue'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import NButton from '@/ui/NButton.vue'
import NIcon from '@/ui/NIcon.vue'
import NTooltip from '@/ui/NTooltip.vue'
import { useDialog, useMessage } from '@/ui/services'

import { useAiConversation } from '@/composables/useAiConversation'
import {
  useAgentRun,
  type AgentRunServiceDependencies,
  type AgentRunDocumentSnapshot,
} from '@/composables/useAgentRun'
import { useAgentPatchWorkflow } from '@/composables/useAgentPatchWorkflow'
import { useDocumentWorkspace } from '@/composables/useDocumentWorkspace'
import { useSensitiveAuthorization } from '@/composables/useSensitiveAuthorization'
import { useDocumentSearch } from '@/composables/useDocumentSearch'
import { useWorkspaceSurface } from '@/composables/useWorkspaceSurface'
import { useDataDirectorySettings } from '@/composables/useDataDirectorySettings'
import { useAiPreferences } from '@/composables/useAiPreferences'
import { useHomeKeyboardShortcuts } from '@/composables/useHomeKeyboardShortcuts'
import { ensureTopLevelBlockIds } from '@/editor/blocks/blockId'
import { parseEditorContentJson } from '@/editor/core/editorContent'
import { EMPTY_TIPTAP_DOCUMENT, type DocumentId, type DocumentSummary } from '@/models/documents/document'
import { UNGROUPED_AGENT_PROJECT_ID } from '@/models/ai/aiChatHistory'
import { createIdleAgentRuntimeState } from '@/models/agent/agentRuntime'
import type { AgentTask } from '@/models/agent/agent'
import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agent/agentTarget'
import type { KnowledgeAsset } from '@/models/knowledge/knowledgeAsset'
import { createEntityId } from '@/models/shared/id'
import {
  createDefaultAppSettings,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from '@/models/settings/settings'
import type { DocumentService } from '@/services/documents/DocumentService'
import type { DocumentTransferService } from '@/services/documents/DocumentTransferService'
import type { AutomationService } from '@/services/automation/AutomationService'
import type { KnowledgeControlService } from '@/services/knowledge/KnowledgeControlService'
import type { WorkspaceViewService } from '@/services/workspace/WorkspaceViewService'
import type { AuditRepository } from '@/repositories/audit/AuditRepository'
import type { RegexReplaceExecutor } from '@/services/agent/AgentCommandService'
import type { AgentCommunicationService } from '@/services/agent/AgentCommunicationService'
import type { DataDirectoryPort } from '@/services/ports/DataDirectoryPort'
import { renderAiMarkdown } from '@/services/ai/AiMarkdownRenderer'
import { generateConversationTitle } from '@/services/ai/ConversationTitleService'
import { applyTheme, setThemePreference, subscribeToSystemTheme } from '@/services/appearance/theme'
import DocumentSidebar from '@/features/documents/components/DocumentSidebar.vue'
import type {
  DocumentSidebarView,
  WorkspaceSurface as WorkspaceSurfaceName,
} from '@/models/workspace/workspaceSurface'
import AgentAuthorizationModal from './home/AgentAuthorizationModal.vue'
import {
  displayDocumentTitle,
  formatDocumentTimestamp,
  normalizeDocumentTitle,
} from '@/models/documents/documentPresentation'
import LazySurfaceLoader from './home/LazySurfaceLoader.vue'
import type { DocumentSidebarExpose, EditorShellExpose } from './home/homePageTypes'
import { useDocumentTransferActions } from './home/useDocumentTransferActions'
import { useHomeAiMessageActions } from './home/useHomeAiMessageActions'
import { useAgentCommunicationWorker } from './home/useAgentCommunicationWorker'
import { useWorkspaceItems } from './home/useWorkspaceItems'
import { useResearchReviewActions } from './home/useResearchReviewActions'
import { useAiChatPanelBindings } from './home/useAiChatPanelBindings'
import WorkspaceEditorPane from './WorkspaceEditorPane.vue'
import WorkspaceActivityRail from './WorkspaceActivityRail.vue'
import WorkspaceTabs, { type WorkspaceTab } from './WorkspaceTabs.vue'
import WorkspaceContextSidebar from './WorkspaceContextSidebar.vue'

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
const WorkspaceItemMetadataModal = defineLazyComponent(
  () => import('./home/WorkspaceItemMetadataModal.vue'),
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
  agentRunServices: AgentRunServiceDependencies
  getWorkspaceViewService: () => Promise<WorkspaceViewService>
  getAgentCommunicationService: () => Promise<AgentCommunicationService>
  dataDirectoryPort: DataDirectoryPort
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
const sidebarView = ref<DocumentSidebarView>('documents')
const knowledgeSection = ref('assets')
const pluginSection = ref('skills')
const automationSection = ref('tasks')
const auditCategory = ref('all')
const settingsSection = ref('general')
const agentProjectCreateRequest = ref(0)

function requestNewAgentProject(): void {
  agentProjectCreateRequest.value += 1
}
const showInspector = ref(false)
const showImportModal = ref(false)
const showShareModal = ref(false)
const workspaceSurface = useWorkspaceSurface()
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
} = workspaceSurface
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
const aiPreferences = useAiPreferences(aiError)
const { aiSettings, aiChatMode, updateAiSettings, resetAiSettings, ensureAiSecretLoaded } =
  aiPreferences
const aiIsRunning = ref(false)
const explicitAgentTargets = ref<AgentExplicitTarget[]>([])
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
  createAndOpen: createAndOpenWorkspaceDocument,
  createAndOpenFromContent: createAndOpenDocumentFromContent,
  load: loadDocument,
  select: selectWorkspaceDocument,
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
  showCreateViewModal,
  mindMaps,
  activeMindMapId,
  workspaceViews,
  activeWorkspaceViewId,
  showWorkspaceItemMetadataModal,
  workspaceItemMetadataMode,
  workspaceItemMetadataTarget,
  workspaceItemMetadataTitle,
  workspaceItemMetadataBusy,
  mindMapService,
  workspaceViewService,
  selectDocument,
  createAndOpenDocument,
  refreshMindMaps,
  refreshWorkspaceViews,
  handleMindMapSaved,
  handleWorkspaceViewSaved,
  openMindMap,
  openWorkspaceView,
  deleteMindMap,
  deleteWorkspaceView,
  handleMindMapDragStart,
  handleWorkspaceViewDragStart,
  handleWorkspacePageDragEnd,
  handleWorkspaceGroupDragOver,
  handleWorkspaceGroupDrop,
  openMindMapMetadata,
  openWorkspaceViewMetadata,
  saveWorkspaceItemRename,
  toggleWorkspaceViewPin,
  openCreateView,
  createAndOpenView,
} = useWorkspaceItems({
  getMindMapService: async () => {
    const provider = dependencies.agentRunServices.getMindMapService
    if (!provider) throw new Error('未配置思维导图服务。')
    return provider()
  },
  getWorkspaceViewService: dependencies.getWorkspaceViewService,
  documents,
  sidebarView,
  isBusy,
  dropTargetGroupId,
  dialog,
  notify: message,
  openDocumentSurface,
  selectDocument: selectWorkspaceDocument,
  createDocument: createAndOpenWorkspaceDocument,
  createDocumentFromContent: createAndOpenDocumentFromContent,
  expandDocument,
  expandGroup,
  endArticleDrag: handleArticleDragEnd,
  dragOverGroup: handleGroupDragOver,
  dropOnGroup: handleGroupDrop,
})

const openTabs = ref<WorkspaceTab[]>([])
const surfaceTitles: Partial<Record<WorkspaceSurfaceName, string>> = {
  agent: 'Agent Work',
  knowledge: '知识控制',
  plugins: '插件技能',
  automations: '自动化任务',
  audit: '审计记录',
  settings: '设置',
}

const activeTab = computed<WorkspaceTab | null>(() => {
  if (activeSurface.value !== 'document') {
    const title = surfaceTitles[activeSurface.value]
    return title
      ? { key: `surface:${activeSurface.value}`, kind: 'surface', id: activeSurface.value, title }
      : null
  }
  if (activeMindMapId.value) {
    const item = mindMaps.value.find((candidate) => candidate.id === activeMindMapId.value)
    return item
      ? { key: `mindmap:${item.id}`, kind: 'mindmap', id: item.id, title: item.title || '未命名思维导图' }
      : null
  }
  if (activeWorkspaceViewId.value) {
    const item = workspaceViews.value.find((candidate) => candidate.id === activeWorkspaceViewId.value)
    return item
      ? { key: `view:${item.id}`, kind: 'view', id: item.id, title: item.title || '未命名视图' }
      : null
  }
  const item = documents.value.find(
    (candidate) => candidate.id === currentDocumentId.value && candidate.documentKind === 'article',
  )
  return item
    ? { key: `document:${item.id}`, kind: 'document', id: item.id, title: displayTitle(item) }
    : null
})

const activeTabKey = computed(() => activeTab.value?.key ?? '')

watch(
  activeTab,
  (tab) => {
    if (!tab) return
    const existingIndex = openTabs.value.findIndex((item) => item.key === tab.key)
    if (existingIndex < 0) openTabs.value.push(tab)
    else openTabs.value.splice(existingIndex, 1, tab)
  },
  { immediate: true },
)

async function activateWorkspaceTab(tab: WorkspaceTab): Promise<void> {
  if (tab.kind === 'document') return selectDocument(tab.id)
  if (tab.kind === 'mindmap') return openMindMap(tab.id)
  if (tab.kind === 'view') return openWorkspaceView(tab.id)
  const actions: Record<string, () => void> = {
    agent: openAgentWorkspace,
    knowledge: openKnowledgeControlSurface,
    plugins: openPluginSkillsSurface,
    automations: openAutomationsSurface,
    audit: openAuditSurface,
    settings: openSettingsSurface,
  }
  actions[tab.id]?.()
}

async function closeWorkspaceTab(key: string): Promise<void> {
  const closingIndex = openTabs.value.findIndex((tab) => tab.key === key)
  if (closingIndex < 0) return
  const wasActive = activeTabKey.value === key
  openTabs.value.splice(closingIndex, 1)
  if (!wasActive) return
  const replacement = openTabs.value[Math.min(closingIndex, openTabs.value.length - 1)]
  if (replacement) await activateWorkspaceTab(replacement)
  else openAgentWorkspace()
}
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
  createRepository: dependencies.agentRunServices.getAgentRepository,
  document: {
    getSnapshot: () => ({
      id: currentDocumentId.value,
      content: editorContent.value,
      dirty: autosave.dirty.value,
      revision: autosave.revision.value,
      blocks: editorShell.value?.getCurrentDocumentBlocks?.() ?? [],
    }),
    loadSnapshot: async (documentId) => {
      if (documentId === currentDocumentId.value && autosave.dirty.value) {
        return {
          id: currentDocumentId.value,
          content: editorContent.value,
          dirty: true,
          revision: autosave.revision.value,
          blocks: editorShell.value?.getCurrentDocumentBlocks?.() ?? [],
        }
      }
      const service = requireDocumentService()
      const [documentResult, blocksResult] = await Promise.all([
        service.getDocument(documentId),
        service.listDocumentBlocks(documentId),
      ])
      if (!documentResult.ok || !documentResult.value || !blocksResult.ok) return null
      return {
        id: documentId,
        content: ensureTopLevelBlockIds(parseEditorContentJson(documentResult.value.contentJson)),
        dirty: false,
        revision: documentResult.value.revision,
        blocks: blocksResult.value.map((block) => ({
          id: block.id,
          type: block.type,
          text: block.plainText,
          index: block.index,
        })),
      }
    },
    applyDocument: (document) => {
      editorContent.value = ensureTopLevelBlockIds(parseEditorContentJson(document.contentJson))
      plainText.value = document.plainText
      autosave.resetSavedState(document.revision)
    },
    mergeDocument: mergeDocumentIntoLists,
    removeDocument: (documentId) => removeDocumentsFromLists([documentId]),
  },
})
const showAgentRollbackToast = ref(false)
let agentRollbackToastTimer: ReturnType<typeof globalThis.setTimeout> | null = null

function dismissAgentRollbackToast(): void {
  showAgentRollbackToast.value = false
  if (agentRollbackToastTimer !== null) {
    globalThis.clearTimeout(agentRollbackToastTimer)
    agentRollbackToastTimer = null
  }
}

function scheduleAgentRollbackToastDismissal(): void {
  dismissAgentRollbackToast()
  showAgentRollbackToast.value = true
  agentRollbackToastTimer = globalThis.setTimeout(dismissAgentRollbackToast, 9_000)
}
const activeAgentTask = computed(
  () => agentTasks.value.find((task) => task.status === 'running') ?? pendingAgentTask.value,
)
const aiConversation = useAiConversation({
  settings: aiSettings,
  mode: aiChatMode,
  error: aiError,
  isRunning: aiIsRunning,
  createId: createDocumentId,
  historyStore: dependencies.agentRunServices.agentWorkspaceHistoryStore,
  stop: stopAiAssistant,
  notify: (content) => message.success(content),
  generateTitle: generateConversationTitle,
})
const aiMessages = aiConversation.messages
const aiPrompt = aiConversation.prompt
const aiChatHistory = aiConversation.history
const aiProjects = aiConversation.projects
const currentAiChatHistoryId = aiConversation.currentHistoryId
const currentAiProjectId = aiConversation.activeProjectId
const currentAiProject = aiConversation.activeProject
const currentAgentRuntimeProjectId = computed(() =>
  currentAiProjectId.value === UNGROUPED_AGENT_PROJECT_ID ? '' : currentAiProjectId.value,
)
const agentWorkspaceOptions = computed(() =>
  documents.value
    .filter((document) => document.documentKind === 'group' && !document.isDeleted)
    .map((document) => ({ label: document.title, value: document.id })),
)
const currentAgentWorkspaceRootIds = computed(() => currentAiProject.value?.workspaceRootIds ?? [])
const agentTargetOptions = computed<AgentTargetOption[]>(() =>
  documents.value
    .filter((document) => document.documentKind === 'article' && !document.isDeleted)
    .map((document) => ({
      kind: 'document',
      id: document.id,
      title: displayTitle(document),
      subtitle: document.id === currentDocumentId.value ? '当前页面' : '知识库页面',
    })),
)

watch(
  documents,
  (availableDocuments) => {
    const agentMvp = availableDocuments.find(
      (document) => document.documentKind === 'group' && document.title.trim() === 'Agent MVP',
    )
    if (agentMvp) aiConversation.ensureDefaultWorkspace(agentMvp.id, agentMvp.title)
  },
  { immediate: true },
)
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
  services: dependencies.agentRunServices,
  explicitTargets: explicitAgentTargets,
  workspace: {
    projectId: currentAgentRuntimeProjectId,
    projectName: computed(() => currentAiProject.value?.name ?? '未分组任务'),
    rootDocumentIds: currentAgentWorkspaceRootIds,
    conversationId: currentAiChatHistoryId,
    ensureConversationId: aiConversation.ensureConversationId,
    requestConversationTitle: aiConversation.requestConversationTitle,
  },
  document: {
    captureSnapshot: () => ({
      id: currentDocumentId.value,
      title: documentTitle.value,
      tags: [...(currentDocument.value?.tags ?? [])],
      sourceUrl: currentDocument.value?.sourceUrl ?? '',
      author: currentDocument.value?.author ?? '',
      text: editorShell.value?.getText?.() || plainText.value,
      markdown: editorShell.value?.getDocumentMarkdown?.() || plainText.value,
      revision: autosave.revision.value,
      blocks: editorShell.value?.getCurrentDocumentBlocks?.() ?? [],
      selectedBlocks: editorShell.value?.getSelectedBlocks?.() ?? [],
      hasBlockSelection: editorShell.value?.hasBlockSelection?.() ?? false,
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
    openDocumentForReview: async (documentId) => {
      await selectDocument(documentId)
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
const agentRuntimeState = computed(() =>
  agentRun.activeConversationId.value === currentAiChatHistoryId.value
    ? agentRun.runtimeState.value
    : createIdleAgentRuntimeState(),
)
const agentCommunicationWorker = useAgentCommunicationWorker({
  getService: dependencies.getAgentCommunicationService,
  agentRun,
  conversation: aiConversation,
  aiIsRunning,
  isApplyingPatches: isApplyingAgentPatches,
  pendingTask: pendingAgentTask,
  pendingPatchSet: pendingAgentPatchSet,
  showPatchModal: showAgentPatchModal,
  aiError,
  createDocumentSnapshot: createAgentCommunicationDocumentSnapshot,
  acceptAllPatches: acceptAllPendingAgentPatches,
  rejectPatches: rejectPendingAgentPatches,
  notifyError: message.error,
})
const agentAuthorizationRequest = computed(() => agentRun.runtimeState.value.authorizationRequest)
let unsubscribeSystemTheme: (() => void) | null = null
const {
  defaultDataDirectory,
  isChangingDataDirectory,
  initializeDefaultDataDirectory,
  chooseDataDirectory,
  restoreDefaultDataDirectory,
} = useDataDirectorySettings({
  dataDirectoryPort: dependencies.dataDirectoryPort,
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
    .map((document) => ({
      id: document.id,
      title: displayTitle(document),
      sourceUrl: document.sourceUrl,
    })),
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
  void refreshMindMaps().catch((mindMapError) => {
    message.error(mindMapError instanceof Error ? mindMapError.message : String(mindMapError))
  })
  void refreshWorkspaceViews().catch((viewError) =>
    message.error(viewError instanceof Error ? viewError.message : String(viewError)),
  )
  if (import.meta.env.DEV) {
    const marks = globalThis.performance
      .getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('notebook:'))
      .map((entry) => `${entry.name}=${Math.round(entry.startTime)}ms`)
    globalThis.console.info(`[startup] ${marks.join(', ')}`)
  }
  void restoreAgentStateForDocument(currentDocumentId.value, { markInterrupted: true })
  void initializeDefaultDataDirectory()
  agentCommunicationWorker.start()
})

onBeforeUnmount(() => {
  globalThis.removeEventListener('keydown', handleDeveloperToolKeydown, true)
  globalThis.removeEventListener('keydown', handleGlobalKeydown)
  agentCommunicationWorker.stop()
  dismissAgentRollbackToast()
  unsubscribeSystemTheme?.()
})

watch(
  [lastAppliedPatchSet, lastAppliedAgentTask, currentDocumentId],
  ([patchSet, task, documentId], [previousPatchSet]) => {
    if (!patchSet || task?.sessionId !== documentId) {
      dismissAgentRollbackToast()
      return
    }
    if (patchSet !== previousPatchSet) scheduleAgentRollbackToastDismissal()
  },
  { flush: 'post' },
)

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

function selectAgentTarget(target: AgentTargetOption): void {
  if (
    explicitAgentTargets.value.some(
      (current) => current.kind === target.kind && current.id === target.id,
    )
  )
    return
  explicitAgentTargets.value = [...explicitAgentTargets.value, { ...target }]
}

function clearAgentTarget(targetId: string): void {
  const target = explicitAgentTargets.value.find((current) => current.id === targetId)
  explicitAgentTargets.value = explicitAgentTargets.value.filter(
    (current) => current.id !== targetId,
  )
  if (target) {
    aiPrompt.value = aiPrompt.value
      .replace(`@${target.title}`, '')
      .replace(/\s{2,}/g, ' ')
      .trimStart()
  }
}

function researchKnowledgeAssets(assets: KnowledgeAsset[]): void {
  if (assets.length === 0) return
  explicitAgentTargets.value = assets.map((asset) => ({
    kind: 'knowledge_asset' as const,
    id: asset.id,
    title: asset.title,
    subtitle: `知识资产 · ${asset.format}`,
    content: asset.content,
  }))
  const mentions = assets.map((asset) => `@${asset.title}`).join(' ')
  aiPrompt.value = `/research ${mentions} 请对这些知识资产进行多文件分析，比较共同点、差异、冲突、证据强弱、局限和待确认问题。`
  openAgentWorkspace()
}

function stopAiAssistant(): void {
  agentRun.stop()
}

function answerAgentAuthorization(requestId: string, answer: string): void {
  if (!agentRun.answerAuthorization(requestId, answer)) {
    message.error('这个授权问题已失效，请等待 Agent 的最新状态')
  }
}

const homeAiMessageActions = useHomeAiMessageActions({
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
const { openChat: openAiChat, openEditorDocument } = homeAiMessageActions

const { handleGlobalKeydown, handleDeveloperToolKeydown } = useHomeKeyboardShortcuts(appSettings, {
  openAgent: openAiChat,
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

function clearAiChat(): void {
  agentRun.resetRuntime()
  aiConversation.clear()
}

const researchReviewActions = useResearchReviewActions({
  messages: aiMessages,
  getResearchCandidateService: dependencies.agentRunServices.getResearchCandidateService,
  isRunning: aiIsRunning,
  currentDocumentId,
  selectDocument,
  runAgent: (prompt) => agentRun.run(prompt),
  notify: message,
})

async function createAgentCommunicationDocumentSnapshot(): Promise<AgentRunDocumentSnapshot> {
  const seedSummary =
    documents.value.find(
      (document) =>
        document.id === currentDocumentId.value &&
        document.documentKind === 'article' &&
        !document.isDeleted,
    ) ??
    documents.value.find((document) => document.documentKind === 'article' && !document.isDeleted)
  if (!seedSummary) {
    return {
      id: '',
      title: '外部 Agent 任务',
      tags: [],
      sourceUrl: '',
      author: '',
      text: '',
      markdown: '',
      revision: null,
      blocks: [],
      selectedBlocks: [],
      hasBlockSelection: false,
      documents: [...documents.value],
    }
  }
  const [documentResult, blocksResult] = await Promise.all([
    requireDocumentService().getDocument(seedSummary.id),
    requireDocumentService().listDocumentBlocks(seedSummary.id),
  ])
  if (!documentResult.ok) throw new Error(documentResult.error.message)
  if (!blocksResult.ok) throw new Error(blocksResult.error.message)
  const document = documentResult.value
  return {
    id: document.id,
    title: document.title,
    tags: [...document.tags],
    sourceUrl: document.sourceUrl,
    author: document.author,
    text: document.plainText,
    markdown: document.plainText,
    revision: document.revision,
    blocks: blocksResult.value.map((block) => ({
      id: block.id,
      type: block.type,
      text: block.plainText,
      markdown: block.plainText,
      index: block.index,
    })),
    selectedBlocks: [],
    hasBlockSelection: false,
    documents: [...documents.value],
  }
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

const aiChatPanelBindings = useAiChatPanelBindings({
  preferences: aiPreferences,
  conversation: aiConversation,
  surface: workspaceSurface,
  homeActions: homeAiMessageActions,
  researchActions: researchReviewActions,
  prompt: aiPrompt,
  error: aiError,
  isRunning: aiIsRunning,
  activeTask: activeAgentTask,
  runtimeState: agentRuntimeState,
  workspaceOptions: agentWorkspaceOptions,
  currentWorkspaceRootIds: currentAgentWorkspaceRootIds,
  currentDocumentTitle: documentTitle,
  knowledgeSourceCount: knowledgeDocumentCount,
  targetOptions: agentTargetOptions,
  explicitTargets: explicitAgentTargets,
  renderMarkdown: renderAiMarkdown,
  run: runAiAssistant,
  stop: stopAiAssistant,
  clear: clearAiChat,
  selectTarget: selectAgentTarget,
  clearTarget: clearAgentTarget,
  writeMessageToChildDocument: homeAiMessageActions.writeMessageToChildDocument,
})
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
      <WorkspaceActivityRail
        :active-surface="activeSurface"
        @agent="openAgentWorkspace"
        @documents="openDocumentSurface"
        @knowledge="openKnowledgeControlSurface"
        @plugins="openPluginSkillsSurface"
        @automations="openAutomationsSurface"
        @audit="openAuditSurface"
        @settings="openSettingsSurface"
      />
      <DocumentSidebar
        v-if="activeSurface === 'document'"
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
        :dragged-mind-map-id="draggedMindMapId"
        :dragged-workspace-view-id="draggedWorkspaceViewId"
        :drop-target-group-id="dropTargetGroupId"
        :import-file-accept="importFileAccept"
        :busy="isBusy"
        :mind-maps="mindMaps"
        :active-mind-map-id="activeMindMapId"
        :workspace-views="workspaceViews"
        :active-workspace-view-id="activeWorkspaceViewId"
        @search="openSearch"
        @agent="openAgentWorkspace"
        @new-view="openCreateView()"
        @plugins="openPluginSkillsSurface"
        @automations="openAutomationsSurface"
        @audit="openAuditSurface"
        @knowledge="openKnowledgeControlSurface"
        @settings="openSettingsSurface"
        @import="importDocumentFile"
        @file-change="handleImportFileChange"
        @create-group="createGroup"
        @create-view="openCreateView"
        @toggle-group="toggleGroup"
        @select-document="selectDocument"
        @select-mind-map="openMindMap"
        @delete-mind-map="deleteMindMap"
        @delete-workspace-view="deleteWorkspaceView"
        @rename-mind-map="openMindMapMetadata($event, 'rename')"
        @properties-mind-map="openMindMapMetadata($event, 'properties')"
        @rename-workspace-view="openWorkspaceViewMetadata($event, 'rename')"
        @properties-workspace-view="openWorkspaceViewMetadata($event, 'properties')"
        @pin-workspace-view="toggleWorkspaceViewPin"
        @select-workspace-view="openWorkspaceView"
        @toggle-document="toggleDocument"
        @properties="openDocumentProperties"
        @rename="startRename"
        @delete="deleteDocument"
        @restore="restoreDocument"
        @permanently-delete="permanentlyDeleteDocument"
        @article-drag-start="handleArticleDragStart"
        @article-drag-end="handleWorkspacePageDragEnd"
        @mind-map-drag-start="handleMindMapDragStart"
        @workspace-view-drag-start="handleWorkspaceViewDragStart"
        @group-drag-over="handleWorkspaceGroupDragOver"
        @group-drag-leave="handleGroupDragLeave"
        @group-drop="handleWorkspaceGroupDrop"
      />
      <WorkspaceContextSidebar
        v-else
        v-model:knowledge-section="knowledgeSection"
        v-model:plugin-section="pluginSection"
        v-model:automation-section="automationSection"
        v-model:audit-category="auditCategory"
        v-model:settings-section="settingsSection"
        :active-surface="activeSurface"
        :projects="aiProjects"
        :histories="aiChatHistory"
        :current-project-id="currentAiProjectId"
        :current-history-id="currentAiChatHistoryId"
        @search="openSearch"
        @select-project="aiConversation.selectProject"
        @select-history="aiConversation.selectHistory"
        @new-task="aiConversation.startTask"
        @new-project="requestNewAgentProject"
      />
      <div class="workspace-main">
        <WorkspaceTabs
          :tabs="openTabs"
          :active-key="activeTabKey"
          @activate="activateWorkspaceTab"
          @close="closeWorkspaceTab"
          @create="openCreateView()"
        />
        <div class="workspace-main__surface">
          <Transition name="settings-surface" mode="out-in">
        <SettingsSurface
          v-if="showSettings"
          key="settings"
          v-model:section="settingsSection"
          context-navigation
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
          @close="openDocumentSurface"
        />

        <PluginSkillsSurface
          v-else-if="showPluginSkills"
          key="plugin-skills"
          v-model:tab="pluginSection"
          context-navigation
          :mcp-client="dependencies.agentRunServices.mcpClient"
        />

        <AutomationSurface
          v-else-if="showAutomations"
          key="automations"
          v-model:tab="automationSection"
          context-navigation
          :current-document-id="currentDocumentId"
          :current-document-title="documentTitle"
          :get-service="dependencies.getAutomationService"
        />

        <AuditSurface
          v-else-if="showAudit"
          key="audit"
          v-model:category="auditCategory"
          context-navigation
          :get-repository="dependencies.getAuditRepository"
        />

        <KnowledgeControlSurface
          v-else-if="showKnowledgeControl"
          key="knowledge-control"
          v-model:tab="knowledgeSection"
          context-navigation
          :current-document-id="currentDocumentId"
          :current-document-revision="currentDocument?.revision ?? 0"
          :get-service="dependencies.getKnowledgeControlService"
          :chat-history="aiChatHistory"
          @research-assets="researchKnowledgeAssets"
        />

        <div
          v-else
          key="document-workspace"
          class="document-workspace"
          :class="{ 'document-workspace--agent-workspace': showAiChat && aiChatFullscreen }"
        >
          <AiChatPanel
            v-if="showAiChat && aiChatFullscreen"
            v-bind="aiChatPanelBindings"
            workspace
            external-navigation
            :project-create-request="agentProjectCreateRequest"
          />

          <WorkspaceEditorPane
            ref="editorShell"
            :active-mind-map-id="activeMindMapId"
            :active-workspace-view-id="activeWorkspaceViewId"
            :mind-maps="mindMaps"
            :workspace-views="workspaceViews"
            :document-title="documentTitle"
            :editor-content="editorContent"
            :editor-settings="editorSettings"
            :internal-documents="internalDocuments"
            :current-document-id="currentDocumentId"
            :current-document="currentDocument"
            :loading="isLoadingDocument"
            :load-error="loadError"
            :busy="isBusy"
            :save-status-class="saveStatusClass"
            :save-status-text="saveStatusText"
            :preparing-share="isPreparingShare"
            :get-mind-map-service="mindMapService"
            :get-workspace-view-service="workspaceViewService"
            :class="{ 'editor-panel--behind-ai': showAiChat && aiChatFullscreen }"
            @update:title="documentTitle = $event"
            @title-input="handleTitleInput"
            @commit-title="commitCurrentTitle"
            @create-child="createAndOpenDocument(currentDocumentId)"
            @share="openShareView"
            @inspect="showInspector = true"
            @search="openSearch"
            @update:editor-content="handleEditorContentUpdate"
            @text-update="handleTextUpdate"
            @image-error="message.error"
            @open-document="openEditorDocument"
            @mind-map-saved="handleMindMapSaved"
            @workspace-view-saved="handleWorkspaceViewSaved"
          />
        </div>
          </Transition>
        </div>
      </div>

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
        v-bind="aiChatPanelBindings"
        :workspace="false"
        docked
      />

      <div
        v-if="
          showAgentRollbackToast &&
          lastAppliedPatchSet &&
          lastAppliedAgentTask?.sessionId === currentDocumentId
        "
        class="agent-rollback-toast"
        role="status"
      >
        <span>最近一次 Agent 修改已写入，可撤销整次操作。</span>
        <NButton size="small" secondary @click="rollbackLastAgentTask">撤销</NButton>
        <button
          type="button"
          class="agent-rollback-toast__close"
          aria-label="关闭撤销提示"
          @click="dismissAgentRollbackToast"
        >
          <X :size="14" />
        </button>
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
        v-if="agentAuthorizationRequest"
        :request="agentAuthorizationRequest"
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

      <WorkspaceItemMetadataModal
        v-if="showWorkspaceItemMetadataModal"
        v-model:show="showWorkspaceItemMetadataModal"
        v-model:title="workspaceItemMetadataTitle"
        :target="workspaceItemMetadataTarget"
        :mode="workspaceItemMetadataMode"
        :busy="workspaceItemMetadataBusy"
        :format-date-time="formatDocumentDateTime"
        @save="saveWorkspaceItemRename"
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
