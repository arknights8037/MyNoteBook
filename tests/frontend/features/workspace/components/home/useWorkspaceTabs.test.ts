import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useWorkspaceTabs } from '@/features/workspace/components/home/useWorkspaceTabs'
import type { DocumentSummary } from '@/models/documents/document'
import type { MindMapSummary } from '@/models/workspace/mindMap'
import type { WorkspaceSurface } from '@/models/workspace/workspaceSurface'
import type { StructuredWorkspaceViewSummary } from '@/models/workspace/workspaceView'

describe('useWorkspaceTabs', () => {
  it('tracks active resources, trims inactive tabs, and activates a replacement on close', async () => {
    const activeSurface = ref<WorkspaceSurface>('home')
    const maxTabs = ref(2)
    const activateDocument = vi.fn()
    const controller = useWorkspaceTabs({
      activeSurface,
      maxTabs,
      currentDocumentId: ref('doc-1'),
      documents: ref<DocumentSummary[]>([document('doc-1')]),
      activeMindMapId: ref(null),
      mindMaps: ref<MindMapSummary[]>([]),
      activeWorkspaceViewId: ref(null),
      workspaceViews: ref<StructuredWorkspaceViewSummary[]>([]),
      activateDocument,
      activateMindMap: vi.fn(),
      activateWorkspaceView: vi.fn(),
      activateSurface: {},
      activateFallback: vi.fn(),
    })

    expect(controller.openTabs.value.map((tab) => tab.key)).toEqual(['surface:home'])
    activeSurface.value = 'document'
    await nextTick()
    activeSurface.value = 'inbox'
    await nextTick()

    expect(controller.openTabs.value.map((tab) => tab.key)).toEqual([
      'document:doc-1',
      'surface:inbox',
    ])
    await controller.closeWorkspaceTab('surface:inbox')
    expect(activateDocument).toHaveBeenCalledWith('doc-1')
  })
})

function document(id: string): DocumentSummary {
  return {
    id,
    parentId: null,
    documentKind: 'article',
    title: '页面',
    tags: [],
    sourceUrl: '',
    author: '',
    description: '',
    plainText: '',
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
