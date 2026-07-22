import { ref, type Ref } from 'vue'

import type { DocumentId, DocumentSummary, TiptapDocumentJson } from '@/models/documents/document'
import type { MindMapSummary } from '@/models/workspace/mindMap'
import type {
  StructuredWorkspaceViewSummary,
  StructuredWorkspaceViewType,
} from '@/models/workspace/workspaceView'
import type { MindMapService } from '@/services/workspace/MindMapService'
import type { WorkspaceViewService } from '@/services/workspace/WorkspaceViewService'
import { displayDocumentTitle } from '@/models/documents/documentPresentation'
import type { DocumentSidebarView } from '@/models/workspace/workspaceSurface'
import { CREATE_VIEW_TEMPLATES, type CreateViewKind } from './viewTemplates'
import type { WorkspaceItemMetadata } from './WorkspaceItemMetadataModal.vue'

interface DialogPort {
  warning(options: {
    title: string
    content: string
    positiveText: string
    negativeText: string
    onPositiveClick: () => void
    onNegativeClick: () => void
    onClose: () => void
  }): void
}

interface WorkspaceItemsOptions {
  getMindMapService: () => Promise<MindMapService>
  getWorkspaceViewService: () => Promise<WorkspaceViewService>
  documents: Readonly<Ref<DocumentSummary[]>>
  sidebarView: Ref<DocumentSidebarView>
  isBusy: Readonly<Ref<boolean>>
  dropTargetGroupId: Ref<DocumentId | null>
  dialog: DialogPort
  notify: { success(message: string): void; error(message: string): void }
  openDocumentSurface: () => void
  selectDocument: (documentId: DocumentId) => Promise<void>
  createDocument: (parentId: DocumentId | null) => Promise<void>
  createDocumentFromContent: (
    title: string,
    input: { content: TiptapDocumentJson; plainText: string; parentId: DocumentId | null },
  ) => Promise<unknown>
  expandDocument: (documentId: DocumentId) => void
  expandGroup: (groupId: DocumentId) => void
  endArticleDrag: () => void
  dragOverGroup: (event: DragEvent, groupId: DocumentId) => void
  dropOnGroup: (event: DragEvent, groupId: DocumentId) => Promise<void>
}

export function useWorkspaceItems(options: WorkspaceItemsOptions) {
  const showCreateViewModal = ref(false)
  const createViewParentId = ref<string | null>(null)
  const mindMaps = ref<MindMapSummary[]>([])
  const activeMindMapId = ref<string | null>(null)
  const draggedMindMapId = ref<string | null>(null)
  const workspaceViews = ref<StructuredWorkspaceViewSummary[]>([])
  const activeWorkspaceViewId = ref<string | null>(null)
  const draggedWorkspaceViewId = ref<string | null>(null)
  const showWorkspaceItemMetadataModal = ref(false)
  const workspaceItemMetadataMode = ref<'rename' | 'properties' | null>(null)
  const workspaceItemMetadataTarget = ref<WorkspaceItemMetadata | null>(null)
  const workspaceItemMetadataTitle = ref('')
  const workspaceItemMetadataBusy = ref(false)
  let mindMapServicePromise: Promise<MindMapService> | null = null
  let workspaceViewServicePromise: Promise<WorkspaceViewService> | null = null

  const mindMapService = () => (mindMapServicePromise ??= options.getMindMapService())
  const workspaceViewService = () =>
    (workspaceViewServicePromise ??= options.getWorkspaceViewService())

  async function selectDocument(documentId: DocumentId): Promise<void> {
    activeMindMapId.value = null
    activeWorkspaceViewId.value = null
    await options.selectDocument(documentId)
  }

  async function createAndOpenDocument(parentId: DocumentId | null): Promise<void> {
    activeMindMapId.value = null
    activeWorkspaceViewId.value = null
    await options.createDocument(parentId)
  }

  async function refreshMindMaps(): Promise<void> {
    const result = await (await mindMapService()).list()
    if (!result.ok) throw new Error(result.error.message)
    mindMaps.value = result.value
  }

  async function refreshWorkspaceViews(): Promise<void> {
    const result = await (await workspaceViewService()).list()
    if (!result.ok) throw new Error(result.error.message)
    workspaceViews.value = result.value
  }

  function handleMindMapSaved(summary: MindMapSummary): void {
    mindMaps.value = [summary, ...mindMaps.value.filter((item) => item.id !== summary.id)]
  }

  function handleWorkspaceViewSaved(summary: StructuredWorkspaceViewSummary): void {
    workspaceViews.value = [
      summary,
      ...workspaceViews.value.filter((item) => item.id !== summary.id),
    ]
  }

  function openMindMap(mindMapId: string): void {
    activeMindMapId.value = mindMapId
    activeWorkspaceViewId.value = null
    options.sidebarView.value = 'documents'
    options.openDocumentSurface()
  }

  function openWorkspaceView(viewId: string): void {
    activeWorkspaceViewId.value = viewId
    activeMindMapId.value = null
    options.sidebarView.value = 'documents'
    options.openDocumentSurface()
  }

  async function createAndOpenMindMap(parentId: string | null = null): Promise<void> {
    const result = await (await mindMapService()).create('新思维导图', parentId)
    if (!result.ok) throw new Error(result.error.message)
    await refreshMindMaps()
    if (parentId) options.expandDocument(parentId)
    openMindMap(result.value.id)
  }

  async function deleteMindMap(mindMapId: string): Promise<void> {
    const item = mindMaps.value.find((candidate) => candidate.id === mindMapId)
    if (!item || !(await confirmRemoval('删除思维导图', item.title, '未命名思维导图'))) return
    const result = await (await mindMapService()).delete(mindMapId)
    if (!result.ok) return options.notify.error(result.error.message)
    mindMaps.value = mindMaps.value.filter((candidate) => candidate.id !== mindMapId)
    if (activeMindMapId.value === mindMapId) activeMindMapId.value = null
    options.notify.success('思维导图已删除')
  }

  async function deleteWorkspaceView(viewId: string): Promise<void> {
    const item = workspaceViews.value.find((candidate) => candidate.id === viewId)
    if (!item || !(await confirmRemoval('删除视图', item.title, '未命名视图'))) return
    const result = await (await workspaceViewService()).delete(viewId)
    if (!result.ok) return options.notify.error(result.error.message)
    workspaceViews.value = workspaceViews.value.filter((candidate) => candidate.id !== viewId)
    if (activeWorkspaceViewId.value === viewId) activeWorkspaceViewId.value = null
    options.notify.success('视图已删除')
  }

  function handleMindMapDragStart(event: DragEvent, mindMapId: string): void {
    if (options.isBusy.value) return event.preventDefault()
    draggedMindMapId.value = mindMapId
    event.dataTransfer?.setData('application/x-my-notebook-mind-map', mindMapId)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function handleWorkspaceViewDragStart(event: DragEvent, viewId: string): void {
    if (options.isBusy.value) return event.preventDefault()
    draggedWorkspaceViewId.value = viewId
    event.dataTransfer?.setData('application/x-my-notebook-workspace-view', viewId)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function handleWorkspacePageDragEnd(): void {
    draggedMindMapId.value = null
    draggedWorkspaceViewId.value = null
    options.endArticleDrag()
  }

  function handleWorkspaceGroupDragOver(event: DragEvent, groupId: DocumentId): void {
    if (draggedMindMapId.value) {
      const item = mindMaps.value.find((candidate) => candidate.id === draggedMindMapId.value)
      if (!item || item.parentId === groupId) return
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      options.dropTargetGroupId.value = groupId
      return
    }
    if (draggedWorkspaceViewId.value) {
      const item = workspaceViews.value.find(
        (candidate) => candidate.id === draggedWorkspaceViewId.value,
      )
      if (!item || item.parentId === groupId) return
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      options.dropTargetGroupId.value = groupId
      return
    }
    options.dragOverGroup(event, groupId)
  }

  async function handleWorkspaceGroupDrop(event: DragEvent, groupId: DocumentId): Promise<void> {
    const mindMapId =
      draggedMindMapId.value ?? event.dataTransfer?.getData('application/x-my-notebook-mind-map')
    const viewId =
      draggedWorkspaceViewId.value ??
      event.dataTransfer?.getData('application/x-my-notebook-workspace-view')
    if (!mindMapId && !viewId) return options.dropOnGroup(event, groupId)
    event.preventDefault()
    handleWorkspacePageDragEnd()

    if (viewId) {
      const item = workspaceViews.value.find((candidate) => candidate.id === viewId)
      if (!item || item.parentId === groupId) return
      const result = await (
        await workspaceViewService()
      ).move({ id: item.id, expectedVersion: item.version, parentId: groupId })
      if (!result.ok) return options.notify.error(result.error.message)
      await refreshWorkspaceViews()
      options.expandGroup(groupId)
      options.notify.success('视图已移动到分组')
      return
    }

    const item = mindMaps.value.find((candidate) => candidate.id === mindMapId)
    if (!item || item.parentId === groupId) return
    const result = await (
      await mindMapService()
    ).move({ id: item.id, expectedVersion: item.version, parentId: groupId })
    if (!result.ok) return options.notify.error(result.error.message)
    await refreshMindMaps()
    options.expandGroup(groupId)
    options.notify.success('思维导图已移动到分组')
  }

  function workspaceParentLabel(parentId: string | null): string {
    if (!parentId) return '空间根目录'
    const document = options.documents.value.find((item) => item.id === parentId)
    if (document) return displayDocumentTitle(document)
    return (
      mindMaps.value.find((item) => item.id === parentId)?.title ??
      workspaceViews.value.find((item) => item.id === parentId)?.title ??
      '未知位置'
    )
  }

  function openMindMapMetadata(id: string, mode: 'rename' | 'properties'): void {
    const item = mindMaps.value.find((candidate) => candidate.id === id)
    if (!item) return
    openMetadata(
      {
        id: item.id,
        kind: 'mindmap',
        title: item.title,
        typeLabel: '思维导图',
        parentLabel: workspaceParentLabel(item.parentId),
        detailLabel: `${item.nodeCount} 个节点`,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        pinned: false,
      },
      mode,
    )
  }

  function openWorkspaceViewMetadata(id: string, mode: 'rename' | 'properties'): void {
    const item = workspaceViews.value.find((candidate) => candidate.id === id)
    if (!item) return
    const labels: Record<StructuredWorkspaceViewType, string> = {
      slides: '幻灯片',
      uml: 'UML / 流程图',
      table: '表格',
    }
    openMetadata(
      {
        id: item.id,
        kind: 'workspace-view',
        title: item.title,
        typeLabel: labels[item.viewType],
        parentLabel: workspaceParentLabel(item.parentId),
        detailLabel: labels[item.viewType],
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        pinned: item.pinnedAt !== null,
      },
      mode,
    )
  }

  function openMetadata(target: WorkspaceItemMetadata, mode: 'rename' | 'properties'): void {
    workspaceItemMetadataTarget.value = target
    workspaceItemMetadataTitle.value = target.title
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
        if (!current.ok) return options.notify.error(current.error.message)
        const result = await service.update({
          id: current.value.id,
          expectedVersion: current.value.version,
          title,
          content: current.value.content,
        })
        if (!result.ok) return options.notify.error(result.error.message)
        await refreshMindMaps()
      } else {
        const service = await workspaceViewService()
        const current = await service.get(target.id)
        if (!current.ok) return options.notify.error(current.error.message)
        const result = await service.update({
          id: current.value.id,
          expectedVersion: current.value.version,
          title,
          payload: current.value.payload,
        })
        if (!result.ok) return options.notify.error(result.error.message)
        await refreshWorkspaceViews()
      }
      showWorkspaceItemMetadataModal.value = false
      options.notify.success('名称已更新')
    } finally {
      workspaceItemMetadataBusy.value = false
    }
  }

  async function toggleWorkspaceViewPin(viewId: string): Promise<void> {
    const item = workspaceViews.value.find((candidate) => candidate.id === viewId)
    if (!item) return
    const result = await (await workspaceViewService()).setPinned(viewId, item.pinnedAt === null)
    if (!result.ok) return options.notify.error(result.error.message)
    await refreshWorkspaceViews()
    options.notify.success(item.pinnedAt === null ? '视图已置顶' : '已取消置顶')
  }

  function openCreateView(parentId: string | null = null): void {
    createViewParentId.value = parentId
    showCreateViewModal.value = true
  }

  async function createAndOpenView(kind: CreateViewKind): Promise<void> {
    const parentId = createViewParentId.value
    createViewParentId.value = null
    showCreateViewModal.value = false
    if (kind === 'mindmap') return createAndOpenMindMap(parentId)
    if (kind === 'slides' || kind === 'uml' || kind === 'table') {
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
    const { parseMarkdownDocument } = await import('@/editor/io/markdownImport')
    const parsed = parseMarkdownDocument(template.markdown, template.title)
    activeMindMapId.value = null
    activeWorkspaceViewId.value = null
    await options.createDocumentFromContent(template.title, {
      content: parsed.content,
      plainText: parsed.plainText,
      parentId,
    })
  }

  function confirmRemoval(title: string, itemTitle: string, fallback: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      options.dialog.warning({
        title,
        content: `删除「${itemTitle.trim() || fallback}」？此操作无法恢复。`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: () => finish(true),
        onNegativeClick: () => finish(false),
        onClose: () => finish(false),
      })
    })
  }

  return {
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
    createAndOpenMindMap,
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
  }
}
