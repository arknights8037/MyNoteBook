import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { ok } from '@/models/shared/result'
import type { MindMapService } from '@/services/workspace/MindMapService'
import type { WorkspaceViewService } from '@/services/workspace/WorkspaceViewService'
import { useWorkspaceItems } from '@/features/workspace/components/home/useWorkspaceItems'

describe('useWorkspaceItems', () => {
  it('keeps document, mind-map and workspace-view selection mutually exclusive', async () => {
    const selected = vi.fn(async () => undefined)
    const controller = createController({ selectDocument: selected })

    controller.openMindMap('map-1')
    expect(controller.activeMindMapId.value).toBe('map-1')

    controller.openWorkspaceView('view-1')
    expect(controller.activeMindMapId.value).toBeNull()
    expect(controller.activeWorkspaceViewId.value).toBe('view-1')

    await controller.selectDocument('doc-1')
    expect(controller.activeWorkspaceViewId.value).toBeNull()
    expect(selected).toHaveBeenCalledWith('doc-1')
  })

  it('creates a typed workspace view through the injected service', async () => {
    const create = vi.fn(async () =>
      ok({
        id: 'view-1',
        parentId: null,
        sortOrder: 0,
        viewType: 'slides' as const,
        title: '新幻灯片',
        payload: { type: 'slides' as const, format: 'slidev' as const, source: '# 新幻灯片', assetIds: [] },
        pinnedAt: null,
        schemaVersion: 1,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    )
    const list = vi.fn(async () => ok([]))
    const controller = createController({
      workspaceViewService: { create, list },
    })

    controller.openCreateView(null)
    await controller.createAndOpenView('slides')

    expect(create).toHaveBeenCalledWith('slides', '新幻灯片', null)
    expect(controller.activeWorkspaceViewId.value).toBe('view-1')
  })

  it('deletes all non-document items belonging to a removed hierarchy', async () => {
    const deleteMindMap = vi.fn(async () => ok(undefined))
    const deleteWorkspaceView = vi.fn(async () => ok(undefined))
    const controller = createController({
      mindMapService: { delete: deleteMindMap },
      workspaceViewService: { delete: deleteWorkspaceView },
    })
    controller.mindMaps.value = [
      {
        id: 'map-1', parentId: 'group-1', sortOrder: 0, title: '地图', rootNodeId: 'root',
        nodeCount: 1, version: 1, createdAt: 1, updatedAt: 1,
      },
    ]
    controller.workspaceViews.value = [
      {
        id: 'view-1', parentId: 'map-1', sortOrder: 0, viewType: 'table', title: '表格',
        pinnedAt: null, version: 1, createdAt: 1, updatedAt: 1,
      },
    ]

    const result = await controller.deleteItemsInContainers(
      new Set(['group-1', 'map-1', 'view-1']),
    )

    expect(result).toEqual({ ok: true, count: 2 })
    expect(deleteMindMap).toHaveBeenCalledWith('map-1')
    expect(deleteWorkspaceView).toHaveBeenCalledWith('view-1')
    expect(controller.mindMaps.value).toEqual([])
    expect(controller.workspaceViews.value).toEqual([])
  })
})

function createController(overrides: {
  selectDocument?: (id: string) => Promise<void>
  mindMapService?: Partial<MindMapService>
  workspaceViewService?: Partial<WorkspaceViewService>
} = {}) {
  const mindMapService = {
    list: vi.fn(async () => ok([])),
    ...overrides.mindMapService,
  } as unknown as MindMapService
  const workspaceViewService = {
    list: vi.fn(async () => ok([])),
    ...overrides.workspaceViewService,
  } as unknown as WorkspaceViewService
  return useWorkspaceItems({
    getMindMapService: async () => mindMapService,
    getWorkspaceViewService: async () => workspaceViewService,
    documents: ref([]),
    sidebarView: ref('documents'),
    isBusy: ref(false),
    dropTargetGroupId: ref(null),
    dialog: { warning: (input) => input.onPositiveClick() },
    notify: { success: vi.fn(), error: vi.fn() },
    openDocumentSurface: vi.fn(),
    selectDocument: overrides.selectDocument ?? vi.fn(async () => undefined),
    createDocument: vi.fn(async () => undefined),
    createDocumentFromContent: vi.fn(async () => undefined),
    expandDocument: vi.fn(),
    expandGroup: vi.fn(),
    endArticleDrag: vi.fn(),
    dragOverGroup: vi.fn(),
    dropOnGroup: vi.fn(async () => undefined),
  })
}
