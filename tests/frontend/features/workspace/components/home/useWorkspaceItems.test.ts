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
        payload: { type: 'slides' as const, slides: [] },
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
})

function createController(overrides: {
  selectDocument?: (id: string) => Promise<void>
  workspaceViewService?: Partial<WorkspaceViewService>
} = {}) {
  const mindMapService = {
    list: vi.fn(async () => ok([])),
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
