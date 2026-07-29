import { computed, ref, watch, type Ref } from 'vue'

import type { DocumentId, DocumentSummary } from '@/models/documents/document'
import { displayDocumentTitle } from '@/models/documents/documentPresentation'
import type { MindMapSummary } from '@/models/workspace/mindMap'
import type { WorkspaceSurface } from '@/models/workspace/workspaceSurface'
import type { StructuredWorkspaceViewSummary } from '@/models/workspace/workspaceView'

export interface WorkspaceTab {
  key: string
  kind: 'document' | 'mindmap' | 'view' | 'surface'
  id: string
  title: string
}

type TabActivation = (id: string) => void | Promise<void>

interface UseWorkspaceTabsOptions {
  activeSurface: Readonly<Ref<WorkspaceSurface>>
  maxTabs: Readonly<Ref<number>>
  currentDocumentId: Readonly<Ref<DocumentId>>
  documents: Readonly<Ref<DocumentSummary[]>>
  activeMindMapId: Readonly<Ref<string | null>>
  mindMaps: Readonly<Ref<MindMapSummary[]>>
  activeWorkspaceViewId: Readonly<Ref<string | null>>
  workspaceViews: Readonly<Ref<StructuredWorkspaceViewSummary[]>>
  activateDocument: TabActivation
  activateMindMap: TabActivation
  activateWorkspaceView: TabActivation
  activateSurface: Partial<Record<WorkspaceSurface, () => void>>
  activateFallback: () => void
}

const persistentSurfaceIds = new Set<WorkspaceSurface>(['home', 'agent', 'inbox', 'knowledge'])
const surfaceTitles: Partial<Record<WorkspaceSurface, string>> = {
  home: '首页',
  agent: 'Agent Work',
  inbox: '收件箱',
  knowledge: '知识控制',
}

export function useWorkspaceTabs(options: UseWorkspaceTabsOptions) {
  const openTabs = ref<WorkspaceTab[]>([])
  const activeTab = computed<WorkspaceTab | null>(() => resolveActiveTab(options))
  const activeTabKey = computed(() => activeTab.value?.key ?? '')

  function trimOpenTabs(): void {
    while (openTabs.value.length > options.maxTabs.value) {
      const removableIndex = openTabs.value.findIndex((tab) => tab.key !== activeTabKey.value)
      if (removableIndex < 0) break
      openTabs.value.splice(removableIndex, 1)
    }
  }

  watch(
    activeTab,
    (tab) => {
      if (!tab) return
      const existingIndex = openTabs.value.findIndex((item) => item.key === tab.key)
      if (existingIndex < 0) openTabs.value.push(tab)
      else openTabs.value.splice(existingIndex, 1, tab)
      trimOpenTabs()
    },
    { immediate: true },
  )
  watch(options.maxTabs, trimOpenTabs)

  async function activateWorkspaceTab(tab: WorkspaceTab): Promise<void> {
    if (tab.kind === 'document') return void (await options.activateDocument(tab.id))
    if (tab.kind === 'mindmap') return void (await options.activateMindMap(tab.id))
    if (tab.kind === 'view') return void (await options.activateWorkspaceView(tab.id))
    options.activateSurface[tab.id as WorkspaceSurface]?.()
  }

  async function closeWorkspaceTab(key: string): Promise<void> {
    const closingIndex = openTabs.value.findIndex((tab) => tab.key === key)
    if (closingIndex < 0) return
    const wasActive = activeTabKey.value === key
    openTabs.value.splice(closingIndex, 1)
    if (!wasActive) return
    const replacement = openTabs.value[Math.min(closingIndex, openTabs.value.length - 1)]
    if (replacement) await activateWorkspaceTab(replacement)
    else options.activateFallback()
  }

  return { openTabs, activeTabKey, activateWorkspaceTab, closeWorkspaceTab }
}

function resolveActiveTab(options: UseWorkspaceTabsOptions): WorkspaceTab | null {
  const surface = options.activeSurface.value
  if (surface !== 'document') {
    if (!persistentSurfaceIds.has(surface)) return null
    const title = surfaceTitles[surface]
    return title ? { key: `surface:${surface}`, kind: 'surface', id: surface, title } : null
  }

  const mindMapId = options.activeMindMapId.value
  if (mindMapId) {
    const item = options.mindMaps.value.find((candidate) => candidate.id === mindMapId)
    return item
      ? {
          key: `mindmap:${item.id}`,
          kind: 'mindmap',
          id: item.id,
          title: item.title || '未命名思维导图',
        }
      : null
  }

  const workspaceViewId = options.activeWorkspaceViewId.value
  if (workspaceViewId) {
    const item = options.workspaceViews.value.find((candidate) => candidate.id === workspaceViewId)
    return item
      ? { key: `view:${item.id}`, kind: 'view', id: item.id, title: item.title || '未命名视图' }
      : null
  }

  const document = options.documents.value.find(
    (candidate) =>
      candidate.id === options.currentDocumentId.value && candidate.documentKind === 'article',
  )
  return document
    ? {
        key: `document:${document.id}`,
        kind: 'document',
        id: document.id,
        title: displayDocumentTitle(document),
      }
    : null
}
