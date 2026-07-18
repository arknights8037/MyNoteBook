<script setup lang="ts">
import { Sparkles, X } from '@lucide/vue'
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'

import NButton from '@/ui/NButton.vue'
import NIcon from '@/ui/NIcon.vue'
import NTooltip from '@/ui/NTooltip.vue'
import { useDialog, useMessage } from '@/ui/services'

import { useAiConversation, type AiConversationMessage } from '@/composables/useAiConversation'
import {
  useAgentRun,
  type AgentRunContinuation,
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
import { ensureTopLevelBlockIds } from '@/editor/blockId'
import { parseEditorContentJson } from '@/editor/editorContent'
import { EMPTY_TIPTAP_DOCUMENT, type DocumentId, type DocumentSummary } from '@/models/document'
import type { MindMapSummary } from '@/models/mindMap'
import type {
  StructuredWorkspaceViewSummary,
  StructuredWorkspaceViewType,
} from '@/models/workspaceView'
import { AI_PROVIDER_CONFIGS } from '@/models/ai'
import { AI_MODE_OPTIONS, type AiChatMode } from '@/models/aiChatMode'
import { UNGROUPED_AGENT_PROJECT_ID } from '@/models/aiChatHistory'
import { createIdleAgentRuntimeState } from '@/models/agentRuntime'
import type { AgentTask } from '@/models/agent'
import type { AgentExplicitTarget, AgentTargetOption } from '@/models/agentTarget'
import type { KnowledgeAsset } from '@/models/knowledgeAsset'
import type { ResearchCandidateRef, ReviewIssue } from '@/models/cognitive'
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
import type { MindMapService } from '@/services/MindMapService'
import { createMindMapService } from '@/app/composition/mindMapServiceFactory'
import { createWorkspaceViewService } from '@/app/composition/workspaceViewServiceFactory'
import type { WorkspaceViewService } from '@/services/WorkspaceViewService'
import type { AuditRepository } from '@/repositories/AuditRepository'
import type { RegexReplaceExecutor } from '@/services/AgentCommandService'
import {
  AgentCommunicationService,
  type AgentCommunicationRequest,
} from '@/services/AgentCommunicationService'
import { renderAiMarkdown } from '@/services/AiMarkdownRenderer'
import { generateConversationTitle } from '@/services/ConversationTitleService'
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
import type { WorkspaceItemMetadata } from './home/WorkspaceItemMetadataModal.vue'

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
const MindMapWorkspace = defineLazySurface(
  () => import('@/features/mind-map/components/MindMapWorkspace.vue'),
)
const WorkspaceViewWorkspace = defineLazySurface(
  () => import('@/features/workspace-views/components/WorkspaceViewWorkspace.vue'),
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
const createViewParentId = ref<string | null>(null)
const mindMaps = ref<MindMapSummary[]>([])
const activeMindMapId = ref<string | null>(null)
const draggedMindMapId = ref<string | null>(null)
const draggedWorkspaceViewId = ref<string | null>(null)
let mindMapServicePromise: Promise<MindMapService> | null = null
const workspaceViews = ref<StructuredWorkspaceViewSummary[]>([])
const activeWorkspaceViewId = ref<string | null>(null)
const showWorkspaceItemMetadataModal = ref(false)
const workspaceItemMetadataMode = ref<'rename' | 'properties' | null>(null)
const workspaceItemMetadataTarget = ref<WorkspaceItemMetadata | null>(null)
const workspaceItemMetadataTitle = ref('')
const workspaceItemMetadataBusy = ref(false)
let workspaceViewServicePromise: Promise<WorkspaceViewService> | null = null
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

function mindMapService(): Promise<MindMapService> {
  return (mindMapServicePromise ??= createMindMapService())
}
function workspaceViewService(): Promise<WorkspaceViewService> {
  return (workspaceViewServicePromise ??= createWorkspaceViewService())
}

async function selectDocument(documentId: DocumentId): Promise<void> {
  activeMindMapId.value = null
  activeWorkspaceViewId.value = null
  await selectWorkspaceDocument(documentId)
}

async function createAndOpenDocument(parentId: DocumentId | null): Promise<void> {
  activeMindMapId.value = null
  activeWorkspaceViewId.value = null
  await createAndOpenWorkspaceDocument(parentId)
}

async function refreshMindMaps(): Promise<void> {
  const result = await (await mindMapService()).list()
  if (!result.ok) throw new Error(result.error.message)
  mindMaps.value = result.value
}

function handleMindMapSaved(summary: MindMapSummary): void {
  const remaining = mindMaps.value.filter((item) => item.id !== summary.id)
  mindMaps.value = [summary, ...remaining]
}

function openMindMap(mindMapId: string): void {
  activeMindMapId.value = mindMapId
  activeWorkspaceViewId.value = null
  sidebarView.value = 'documents'
  openDocumentSurface()
}

async function createAndOpenMindMap(parentId: string | null = null): Promise<void> {
  const result = await (await mindMapService()).create('新思维导图', parentId)
  if (!result.ok) throw new Error(result.error.message)
  await refreshMindMaps()
  if (parentId) expandDocument(parentId)
  openMindMap(result.value.id)
}

async function deleteMindMap(mindMapId: string): Promise<void> {
  const mindMap = mindMaps.value.find((item) => item.id === mindMapId)
  if (!mindMap || !(await confirmMindMapRemoval(mindMap.title))) return
  const result = await (await mindMapService()).delete(mindMapId)
  if (!result.ok) return message.error(result.error.message)
  mindMaps.value = mindMaps.value.filter((item) => item.id !== mindMapId)
  if (activeMindMapId.value === mindMapId) activeMindMapId.value = null
  message.success('思维导图已删除')
}

function confirmMindMapRemoval(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.warning({
      title: '删除思维导图',
      content: `删除「${title.trim() || '未命名思维导图'}」？此操作无法恢复。`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}

function handleMindMapDragStart(
  event: InstanceType<typeof globalThis.DragEvent>,
  mindMapId: string,
): void {
  if (isBusy.value) return event.preventDefault()
  draggedMindMapId.value = mindMapId
  event.dataTransfer?.setData('application/x-my-notebook-mind-map', mindMapId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function handleWorkspaceViewDragStart(
  event: InstanceType<typeof globalThis.DragEvent>,
  viewId: string,
): void {
  if (isBusy.value) return event.preventDefault()
  draggedWorkspaceViewId.value = viewId
  event.dataTransfer?.setData('application/x-my-notebook-workspace-view', viewId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function handleWorkspacePageDragEnd(): void {
  draggedMindMapId.value = null
  draggedWorkspaceViewId.value = null
  handleArticleDragEnd()
}

function handleWorkspaceGroupDragOver(
  event: InstanceType<typeof globalThis.DragEvent>,
  groupId: DocumentId,
): void {
  if (draggedMindMapId.value) {
    const mindMap = mindMaps.value.find((item) => item.id === draggedMindMapId.value)
    if (!mindMap || mindMap.parentId === groupId) return
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropTargetGroupId.value = groupId
    return
  }
  if (draggedWorkspaceViewId.value) {
    const view = workspaceViews.value.find((item) => item.id === draggedWorkspaceViewId.value)
    if (!view || view.parentId === groupId) return
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropTargetGroupId.value = groupId
    return
  }
  handleGroupDragOver(event, groupId)
}

async function handleWorkspaceGroupDrop(
  event: InstanceType<typeof globalThis.DragEvent>,
  groupId: DocumentId,
): Promise<void> {
  const mindMapId =
    draggedMindMapId.value ?? event.dataTransfer?.getData('application/x-my-notebook-mind-map')
  const workspaceViewId =
    draggedWorkspaceViewId.value ??
    event.dataTransfer?.getData('application/x-my-notebook-workspace-view')
  if (!mindMapId && !workspaceViewId) return handleGroupDrop(event, groupId)
  event.preventDefault()
  handleWorkspacePageDragEnd()
  if (workspaceViewId) {
    const view = workspaceViews.value.find((item) => item.id === workspaceViewId)
    if (!view || view.parentId === groupId) return
    const result = await (
      await workspaceViewService()
    ).move({
      id: view.id,
      expectedVersion: view.version,
      parentId: groupId,
    })
    if (!result.ok) return message.error(result.error.message)
    await refreshWorkspaceViews()
    expandGroup(groupId)
    message.success('视图已移动到分组')
    return
  }
  if (!mindMapId) return
  const mindMap = mindMaps.value.find((item) => item.id === mindMapId)
  if (!mindMap || mindMap.parentId === groupId) return
  const result = await (
    await mindMapService()
  ).move({
    id: mindMap.id,
    expectedVersion: mindMap.version,
    parentId: groupId,
  })
  if (!result.ok) return message.error(result.error.message)
  await refreshMindMaps()
  expandGroup(groupId)
  message.success('思维导图已移动到分组')
}
async function refreshWorkspaceViews(): Promise<void> {
  const result = await (await workspaceViewService()).list()
  if (!result.ok) throw new Error(result.error.message)
  workspaceViews.value = result.value
}
function openWorkspaceView(viewId: string): void {
  activeWorkspaceViewId.value = viewId
  activeMindMapId.value = null
  sidebarView.value = 'documents'
  openDocumentSurface()
}
function handleWorkspaceViewSaved(summary: StructuredWorkspaceViewSummary): void {
  workspaceViews.value = [summary, ...workspaceViews.value.filter((item) => item.id !== summary.id)]
}
async function deleteWorkspaceView(viewId: string): Promise<void> {
  const view = workspaceViews.value.find((item) => item.id === viewId)
  if (!view || !(await confirmWorkspaceViewRemoval(view.title))) return
  const result = await (await workspaceViewService()).delete(viewId)
  if (!result.ok) return message.error(result.error.message)
  workspaceViews.value = workspaceViews.value.filter((item) => item.id !== viewId)
  if (activeWorkspaceViewId.value === viewId) activeWorkspaceViewId.value = null
  message.success('视图已删除')
}

function workspaceParentLabel(parentId: string | null): string {
  if (!parentId) return '空间根目录'
  const parentDocument = documents.value.find((item) => item.id === parentId)
  if (parentDocument) return displayDocumentTitle(parentDocument)
  return (
    mindMaps.value.find((item) => item.id === parentId)?.title ??
    workspaceViews.value.find((item) => item.id === parentId)?.title ??
    '未知位置'
  )
}

function openMindMapMetadata(mindMapId: string, mode: 'rename' | 'properties'): void {
  const item = mindMaps.value.find((candidate) => candidate.id === mindMapId)
  if (!item) return
  workspaceItemMetadataTarget.value = {
    id: item.id,
    kind: 'mindmap',
    title: item.title,
    typeLabel: '思维导图',
    parentLabel: workspaceParentLabel(item.parentId),
    detailLabel: `${item.nodeCount} 个节点`,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    pinned: false,
  }
  workspaceItemMetadataTitle.value = item.title
  workspaceItemMetadataMode.value = mode
  showWorkspaceItemMetadataModal.value = true
}

function openWorkspaceViewMetadata(viewId: string, mode: 'rename' | 'properties'): void {
  const item = workspaceViews.value.find((candidate) => candidate.id === viewId)
  if (!item) return
  const labels: Record<StructuredWorkspaceViewType, string> = {
    slides: '幻灯片',
    uml: 'UML / 流程图',
    table: '表格',
  }
  workspaceItemMetadataTarget.value = {
    id: item.id,
    kind: 'workspace-view',
    title: item.title,
    typeLabel: labels[item.viewType],
    parentLabel: workspaceParentLabel(item.parentId),
    detailLabel: labels[item.viewType],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    pinned: item.pinnedAt !== null,
  }
  workspaceItemMetadataTitle.value = item.title
  workspaceItemMetadataMode.value = mode
  showWorkspaceItemMetadataModal.value = true
}

async function saveWorkspaceItemRename(): Promise<void> {
  const target = workspaceItemMetadataTarget.value
  const title = workspaceItemMetadataTitle.value.trim()
  if (!target || !title || workspaceItemMetadataBusy.value) return
  workspaceItemMetadataBusy.value = true
  try {
    if (target.kind === 'mindmap') {
      const service = await mindMapService()
      const current = await service.get(target.id)
      if (!current.ok) return message.error(current.error.message)
      const result = await service.update({
        id: current.value.id,
        expectedVersion: current.value.version,
        title,
        content: current.value.content,
      })
      if (!result.ok) return message.error(result.error.message)
      await refreshMindMaps()
    } else {
      const service = await workspaceViewService()
      const current = await service.get(target.id)
      if (!current.ok) return message.error(current.error.message)
      const result = await service.update({
        id: current.value.id,
        expectedVersion: current.value.version,
        title,
        payload: current.value.payload,
      })
      if (!result.ok) return message.error(result.error.message)
      await refreshWorkspaceViews()
    }
    showWorkspaceItemMetadataModal.value = false
    message.success('名称已更新')
  } finally {
    workspaceItemMetadataBusy.value = false
  }
}

async function toggleWorkspaceViewPin(viewId: string): Promise<void> {
  const item = workspaceViews.value.find((candidate) => candidate.id === viewId)
  if (!item) return
  const result = await (await workspaceViewService()).setPinned(viewId, item.pinnedAt === null)
  if (!result.ok) return message.error(result.error.message)
  await refreshWorkspaceViews()
  message.success(item.pinnedAt === null ? '视图已置顶' : '已取消置顶')
}
function confirmWorkspaceViewRemoval(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    dialog.warning({
      title: '删除视图',
      content: `删除「${title.trim() || '未命名视图'}」？此操作无法恢复。`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    })
  })
}
function openCreateView(parentId: string | null = null): void {
  createViewParentId.value = parentId
  showCreateViewModal.value = true
}
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
  stop: stopAiAssistant,
  notify: (content) => message.success(content),
  generateTitle: generateConversationTitle,
})
const aiMessages = aiConversation.messages
const aiPrompt = aiConversation.prompt
const aiChatHistory = aiConversation.history
const currentAiChatHistoryId = aiConversation.currentHistoryId
const aiProjects = aiConversation.projects
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
const agentCommunication = new AgentCommunicationService()
let agentCommunicationTimer: ReturnType<typeof globalThis.setInterval> | null = null
let isPollingAgentCommunication = false
let hasCheckedLegacyAgentCommunicationLeaks = false
const agentRuntimeState = computed(() =>
  agentRun.activeConversationId.value === currentAiChatHistoryId.value
    ? agentRun.runtimeState.value
    : createIdleAgentRuntimeState(),
)
const agentAuthorizationRequest = computed(() => agentRun.runtimeState.value.authorizationRequest)
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
  void pollAgentCommunication()
  agentCommunicationTimer = globalThis.setInterval(() => void pollAgentCommunication(), 1_000)
})

onBeforeUnmount(() => {
  globalThis.removeEventListener('keydown', handleDeveloperToolKeydown, true)
  globalThis.removeEventListener('keydown', handleGlobalKeydown)
  if (agentCommunicationTimer !== null) globalThis.clearInterval(agentCommunicationTimer)
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

async function handleResearchCandidateAction(input: {
  messageId: string
  itemId: string
  candidateId: string
  expectedVersion: number
  action: 'keep' | 'approve' | 'reject'
  title?: string
  content?: string
}): Promise<void> {
  const targetMessage = aiMessages.value.find((item) => item.id === input.messageId)
  const candidateIndex = targetMessage?.researchCandidates?.findIndex(
    (candidate) => candidate.itemId === input.itemId && candidate.candidateId === input.candidateId,
  )
  if (!targetMessage?.researchResult || candidateIndex === undefined || candidateIndex < 0) return
  const current = targetMessage.researchCandidates?.[candidateIndex]
  if (!current) return

  try {
    const { createResearchCandidateService } =
      await import('@/app/composition/researchCandidateServiceFactory')
    const service = await createResearchCandidateService((prefix) =>
      createEntityId(prefix.replace(/[^a-z0-9-]/gi, '-')),
    )
    let next: ResearchCandidateRef = current
    if (
      input.title !== undefined &&
      input.content !== undefined &&
      (input.title.trim() !== current.title || input.content.trim() !== current.content)
    ) {
      const revised = await service.revise({
        candidateId: input.candidateId,
        expectedVersion: input.expectedVersion,
        title: input.title,
        content: input.content,
      })
      if (!revised.ok) throw new Error(revised.error.message)
      next = revised.value
    }
    const decided = await service.decide({
      candidateId: next.candidateId,
      expectedVersion: next.version,
      action: input.action,
    })
    if (!decided.ok) {
      next = {
        ...next,
        sourceState: decided.error.code === 'revision-conflict' ? 'stale' : next.sourceState,
        error: decided.error.message,
      }
    } else {
      next = decided.value
    }
    targetMessage.researchCandidates!.splice(candidateIndex, 1, next)
    if (!decided.ok) {
      message.error(decided.error.message)
      return
    }
    if (input.action === 'approve') {
      const relations = await service.materializeApprovedRelations({
        relations: targetMessage.researchResult.relations,
        candidates: targetMessage.researchCandidates!,
      })
      if (!relations.ok) throw new Error(relations.error.message)
    }
    message.success(
      input.action === 'approve'
        ? '候选已接受为正式知识'
        : input.action === 'reject'
          ? '候选已拒绝'
          : '候选已保留，稍后仍可处理',
    )
  } catch (candidateError) {
    const errorText =
      candidateError instanceof Error ? candidateError.message : String(candidateError)
    targetMessage.researchCandidates!.splice(candidateIndex, 1, {
      ...current,
      error: errorText,
    })
    message.error(errorText)
  }
}

async function resolveReviewIssue(input: { messageId: string; issue: ReviewIssue }): Promise<void> {
  if (aiIsRunning.value) {
    message.error('请先等待当前 Agent 任务结束')
    return
  }
  if (input.issue.sourceState === 'stale') {
    message.error('该问题的来源已变化，请重新执行 Review')
    return
  }
  const targetDocumentId = input.issue.sources[0]?.documentId
  if (targetDocumentId && targetDocumentId !== currentDocumentId.value) {
    await selectDocument(targetDocumentId)
  }
  const { buildReviewIssueResolutionPrompt } = await import('@/services/ReviewResultService')
  await agentRun.run(buildReviewIssueResolutionPrompt(input.issue))
}

async function pollAgentCommunication(): Promise<void> {
  if (isPollingAgentCommunication || aiIsRunning.value || isApplyingAgentPatches.value) return
  isPollingAgentCommunication = true
  let claimedRequest: AgentCommunicationRequest | null = null
  let continuation: AgentRunContinuation | undefined
  try {
    if (!hasCheckedLegacyAgentCommunicationLeaks) {
      const completedRequests = await agentCommunication.listRecentCompleted()
      for (const completedRequest of completedRequests) {
        aiConversation.migrateLeakedTask({
          id: completedRequest.id,
          title: `A2A · ${completedRequest.prompt}`,
          prompt: toAgentCommunicationPrompt(completedRequest),
        })
      }
      hasCheckedLegacyAgentCommunicationLeaks = true
    }
    const decision = pendingAgentTask.value
      ? await agentCommunication.findDecisionForTask(pendingAgentTask.value.id)
      : null
    if (decision) {
      if (decision.status === 'approved') {
        await acceptAllPendingAgentPatches()
        if (pendingAgentTask.value?.id === decision.taskId) {
          const failure = aiError.value || 'Patch 应用未完成。'
          await agentCommunication.markFailed(decision.id, decision.taskId, failure)
          await rejectPendingAgentPatches()
          return
        }
        await agentCommunication.markCompleted(decision.id, decision.taskId)
      } else {
        await rejectPendingAgentPatches()
        await agentCommunication.markCompleted(decision.id, decision.taskId)
      }
      return
    }
    if (pendingAgentTask.value && pendingAgentPatchSet.value) {
      const revisionRequest = await agentCommunication.claimRevisionForTask(
        pendingAgentTask.value.id,
      )
      if (revisionRequest) {
        continuation = {
          previousTaskId: pendingAgentTask.value.id,
          feedback: revisionRequest.revisionFeedback ?? '请修订现有提案。',
          previousSummary: revisionRequest.result?.summary ?? '',
          patches: pendingAgentPatchSet.value.patches.map((patch) => ({ ...patch })),
        }
        claimedRequest = revisionRequest
        await rejectPendingAgentPatches()
      }
    }
    if (pendingAgentTask.value) {
      const failedRequest = await agentCommunication.findFailedForTask(pendingAgentTask.value.id)
      if (failedRequest) {
        await rejectPendingAgentPatches()
        return
      }
    }
    if (!claimedRequest && (showAgentPatchModal.value || pendingAgentTask.value)) return
    const request = claimedRequest ?? (await agentCommunication.claimNext())
    if (!request) return
    claimedRequest = request

    const runtimePrompt = toAgentCommunicationPrompt(request)
    const routedConversationId = request.branchId ?? request.id
    const existingTask = aiChatHistory.value.find((item) => item.id === routedConversationId)
    const routedProjectId = request.projectId ?? existingTask?.projectId
    const detachedProject = aiProjects.value.find((project) => project.id === routedProjectId)
    const detachedMessages = ref<AiConversationMessage[]>(
      existingTask?.messages.map((item) => ({ ...item })) ?? [],
    )
    const detachedPrompt = ref(runtimePrompt)
    const detachedMode = ref<AiChatMode>('agent')
    const detachedError = ref('')
    const detachedConversationId = ref<string | null>(routedConversationId)
    const detachedProjectId = ref(detachedProject?.id ?? request.projectId ?? '')
    const detachedProjectName = ref(detachedProject?.name ?? '外部 Agent 任务')
    const detachedWorkspaceRoots = ref([...(detachedProject?.workspaceRootIds ?? [])])
    const documentSnapshot = await createAgentCommunicationDocumentSnapshot()
    await agentRun.run(runtimePrompt, continuation, {
      mode: detachedMode,
      prompt: detachedPrompt,
      messages: detachedMessages,
      error: detachedError,
      documentSnapshot,
      explicitTargets: ref([]),
      background: true,
      workspace: {
        projectId: detachedProjectId,
        projectName: detachedProjectName,
        rootDocumentIds: detachedWorkspaceRoots,
        conversationId: detachedConversationId,
        ensureConversationId: () => routedConversationId,
      },
    })
    aiConversation.saveDetachedTask({
      id: routedConversationId,
      projectId: detachedProject?.id ?? request.projectId ?? undefined,
      parentConversationId: request.parentConversationId,
      title: request.branchTitle ?? `A2A · ${request.prompt}`,
      messages: detachedMessages.value,
    })
    const taskId = agentRun.lastTaskId.value
    const result = agentRun.lastRunReport.value

    if (pendingAgentTask.value) {
      await agentCommunication.markAwaitingReview(
        request.id,
        pendingAgentTask.value.id,
        result ?? {
          version: 1,
          outcome: 'proposal',
          summary: '已生成待确认修改提案。',
          patchCount: pendingAgentPatchSet.value?.patches.length ?? 0,
          targetDocumentIds: Array.from(
            new Set(pendingAgentPatchSet.value?.patches.map((patch) => patch.documentId) ?? []),
          ),
        },
      )
      showAgentPatchModal.value = false
    } else if (
      agentRun.runtimeState.value.status === 'failed' ||
      agentRun.runtimeState.value.status === 'cancelled'
    ) {
      await agentCommunication.markFailed(
        request.id,
        taskId,
        agentRun.runtimeState.value.detail ||
          (agentRun.runtimeState.value.status === 'cancelled'
            ? 'Agent 任务已取消。'
            : 'Agent 任务失败。'),
      )
    } else if (!taskId) {
      await agentCommunication.markFailed(
        request.id,
        null,
        detachedError.value || agentRun.lastRunIssue.value || 'Agent 请求未创建可追溯任务。',
      )
    } else if (result) {
      await agentCommunication.markCompleted(request.id, taskId, result)
    } else {
      await agentCommunication.markFailed(
        request.id,
        taskId,
        'Agent 任务结束但没有返回标准 result。',
      )
    }
  } catch (error) {
    if (claimedRequest) {
      await agentCommunication.markFailed(
        claimedRequest.id,
        pendingAgentTask.value?.id ?? null,
        error instanceof Error ? error.message : String(error),
      )
    }
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    isPollingAgentCommunication = false
  }
}

function toAgentCommunicationPrompt(request: AgentCommunicationRequest): string {
  const command =
    request.mode === 'learning'
      ? 'learn'
      : request.mode === 'research' || request.mode === 'review'
        ? request.mode
        : null
  return command ? `/${command} ${request.prompt}` : request.prompt
}

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

const forkAiChatAtMessage = aiConversation.forkAtMessage
const editAiChatMessage = aiConversation.editMessage

const deleteAiChatHistory = aiConversation.deleteHistory

const renderMarkdownMessage = renderAiMarkdown

async function createAndOpenView(kind: CreateViewKind): Promise<void> {
  const parentId = createViewParentId.value
  createViewParentId.value = null
  if (kind === 'mindmap') {
    showCreateViewModal.value = false
    await createAndOpenMindMap(parentId)
    return
  }
  if (kind === 'slides' || kind === 'uml' || kind === 'table') {
    showCreateViewModal.value = false
    const titles: Record<StructuredWorkspaceViewType, string> = {
      slides: '新幻灯片',
      uml: '新 UML 图',
      table: '新表格',
    }
    const result = await (await workspaceViewService()).create(kind, titles[kind], parentId)
    if (!result.ok) throw new Error(result.error.message)
    await refreshWorkspaceViews()
    openWorkspaceView(result.value.id)
    return
  }
  const template = CREATE_VIEW_TEMPLATES[kind]
  const { parseMarkdownDocument } = await import('@/editor/markdownImport')
  const parsed = parseMarkdownDocument(template.markdown, template.title)
  showCreateViewModal.value = false
  activeMindMapId.value = null

  await createAndOpenDocumentFromContent(template.title, {
    content: parsed.content,
    plainText: parsed.plainText,
    parentId,
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

const aiChatPanelBindings = computed(() => ({
  prompt: aiPrompt.value,
  mode: aiChatMode.value,
  modeLabel: aiModeLabel.value,
  modeOptions: AI_MODE_OPTIONS,
  providerLabel: aiProviderLabel.value,
  providerOptions: AI_PROVIDER_CONFIGS,
  reasoningLabel: aiReasoningLabel.value,
  reasoningOptions: AI_REASONING_OPTIONS,
  modelOptions: aiModelOptions.value,
  settings: aiSettings.value,
  messages: aiMessages.value,
  chatHistory: aiChatHistory.value,
  currentHistoryId: currentAiChatHistoryId.value,
  projects: aiProjects.value,
  currentProjectId: currentAiProjectId.value,
  workspaceOptions: agentWorkspaceOptions.value,
  currentWorkspaceRootIds: currentAgentWorkspaceRootIds.value,
  currentDocumentTitle: documentTitle.value,
  knowledgeSourceCount: knowledgeDocumentCount.value,
  promptPlaceholder: aiPromptPlaceholder.value,
  error: aiError.value,
  isRunning: aiIsRunning.value,
  agentStep: activeAgentTask.value?.currentStep ?? '',
  runtimeState: agentRuntimeState.value,
  renderMarkdownMessage,
  targetOptions: agentTargetOptions.value,
  explicitTargets: explicitAgentTargets.value,
  'onUpdate:prompt': (value: string) => {
    aiPrompt.value = value
  },
  onSelectMode: selectAiMode,
  onSelectProvider: selectAiProvider,
  onSelectModel: selectAiModel,
  onSelectReasoning: selectAiReasoning,
  onToggleWorkspace: setAiChatWorkspace,
  onForkMessage: forkAiChatAtMessage,
  onEditMessage: editAiChatMessage,
  onRetryMessage: retryAiChatMessage,
  onSelectHistory: selectAiChatHistory,
  onDeleteHistory: deleteAiChatHistory,
  onSelectProject: aiConversation.selectProject,
  onCreateProject: aiConversation.createProject,
  onNewTask: aiConversation.startTask,
  onPinProject: aiConversation.toggleProjectPin,
  onPinHistory: aiConversation.toggleHistoryPin,
  onMoveHistory: aiConversation.moveHistoryToProject,
  onRenameProject: aiConversation.renameProject,
  onUpdateWorkspace: aiConversation.updateWorkspace,
  onClose: closeAiChat,
  onRun: runAiAssistant,
  onStop: stopAiAssistant,
  onClear: clearAiChat,
  onInsert: insertAiMessage,
  onCopyMessage: copyAiMessage,
  onWriteMessageToChild: writeAiMessageToChildDocument,
  onOpenSource: openAiSourceDocument,
  onResearchCandidateAction: handleResearchCandidateAction,
  onResolveReviewIssue: resolveReviewIssue,
  onSelectTarget: selectAgentTarget,
  onClearTarget: clearAgentTarget,
}))
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
          />

          <section
            class="editor-panel"
            :class="{ 'editor-panel--behind-ai': showAiChat && aiChatFullscreen }"
            :aria-hidden="showAiChat && aiChatFullscreen"
          >
            <MindMapWorkspace
              v-if="activeMindMapId"
              :key="`${activeMindMapId}:${mindMaps.find((item) => item.id === activeMindMapId)?.version ?? 0}`"
              :mind-map-id="activeMindMapId"
              @saved="handleMindMapSaved"
            />
            <WorkspaceViewWorkspace
              v-else-if="activeWorkspaceViewId"
              :key="`${activeWorkspaceViewId}:${workspaceViews.find((item) => item.id === activeWorkspaceViewId)?.version ?? 0}`"
              :view-id="activeWorkspaceViewId"
              @saved="handleWorkspaceViewSaved"
            />
            <template v-else>
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
                @unresolved-document-link="message.error(`未找到链接对应的知识库文档：${$event}`)"
              />
            </template>
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
