import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useWorkspaceGroupRemoval } from '@/features/workspace/components/home/useWorkspaceGroupRemoval'
import type { DocumentKind, DocumentSummary } from '@/models/documents/document'

describe('useWorkspaceGroupRemoval', () => {
  it('collects mixed nested items before deleting a whole group', async () => {
    const group = document('group', null, 'group')
    const page = document('page', 'group')
    const nested = document('nested', 'page')
    const deleteDocument = vi.fn(async () => true)
    const deleteItemsInContainers = vi.fn(async () => ({ ok: true as const, count: 2 }))
    const success = vi.fn()
    const controller = useWorkspaceGroupRemoval({
      documents: ref([group, page, nested]),
      mindMaps: ref([
        {
          id: 'map',
          parentId: 'nested',
          sortOrder: 0,
          title: '地图',
          rootNodeId: 'root',
          nodeCount: 1,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      workspaceViews: ref([
        {
          id: 'view',
          parentId: 'map',
          sortOrder: 0,
          viewType: 'table' as const,
          title: '表格',
          pinnedAt: null,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      dialog: { warning: (options) => options.onPositiveClick?.() },
      notify: { success, error: vi.fn() },
      authorize: vi.fn(async () => true),
      deleteDocument,
      deleteItemsInContainers,
    })

    await controller.deleteEntireGroup(group)

    expect(deleteDocument).toHaveBeenCalledWith(
      group,
      expect.objectContaining({ additionalDescendants: [page, nested] }),
    )
    expect(deleteItemsInContainers).toHaveBeenCalledOnce()
    expect([...deleteItemsInContainers.mock.calls[0]![0]]).toEqual([
      'group',
      'page',
      'nested',
      'map',
      'view',
    ])
    expect(success).toHaveBeenCalledWith('整个分组已移除，2 个视图已删除')
  })
})

function document(
  id: string,
  parentId: string | null,
  documentKind: DocumentKind = 'article',
): DocumentSummary {
  return {
    id,
    parentId,
    documentKind,
    title: id,
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
