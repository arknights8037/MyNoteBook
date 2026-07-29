import type { Ref } from 'vue'

import type { DocumentSummary } from '@/models/documents/document'
import type { MindMapSummary } from '@/models/workspace/mindMap'
import { collectWorkspaceTreeIds } from '@/models/workspace/workspaceTree'
import type { StructuredWorkspaceViewSummary } from '@/models/workspace/workspaceView'
import type { DialogService, MessageService } from '@/ui/services'
import { confirmEntireGroupRemoval } from './documentRemovalConfirmation'

interface DocumentDeleteControl {
  confirmed: true
  authorized: true
  notify: false
  additionalDescendants: DocumentSummary[]
}

interface UseWorkspaceGroupRemovalOptions {
  documents: Readonly<Ref<DocumentSummary[]>>
  mindMaps: Readonly<Ref<MindMapSummary[]>>
  workspaceViews: Readonly<Ref<StructuredWorkspaceViewSummary[]>>
  dialog: DialogService
  notify: MessageService
  authorize: (title: string, description: string) => Promise<boolean>
  deleteDocument: (document: DocumentSummary, control: DocumentDeleteControl) => Promise<boolean>
  deleteItemsInContainers: (
    containerIds: ReadonlySet<string>,
  ) => Promise<{ ok: true; count: number } | { ok: false; message: string }>
}

export function useWorkspaceGroupRemoval(options: UseWorkspaceGroupRemovalOptions) {
  async function deleteEntireGroup(group: DocumentSummary): Promise<void> {
    const containerIds = collectEntireGroupItemIds(group.id)
    const descendants = options.documents.value.filter(
      (item) => item.documentKind === 'article' && containerIds.has(item.id),
    )
    const mindMapCount = options.mindMaps.value.filter((item) => containerIds.has(item.id)).length
    const workspaceViewCount = options.workspaceViews.value.filter((item) =>
      containerIds.has(item.id),
    ).length
    const permanentCount = mindMapCount + workspaceViewCount
    const confirmed = await confirmEntireGroupRemoval(
      options.dialog,
      group,
      descendants.length,
      mindMapCount,
      workspaceViewCount,
    )
    if (!confirmed) return
    const authorized = await options.authorize(
      '删除整个分组',
      permanentCount
        ? `分组和文档将移入回收站，另有 ${permanentCount} 个视图将被永久删除。`
        : '分组及其文档将移入回收站。',
    )
    if (!authorized) return

    const documentsDeleted = await options.deleteDocument(group, {
      confirmed: true,
      authorized: true,
      notify: false,
      additionalDescendants: descendants,
    })
    if (!documentsDeleted) return

    const workspaceItemsDeleted = await options.deleteItemsInContainers(containerIds)
    if (!workspaceItemsDeleted.ok) {
      options.notify.error(
        `分组文档已移入回收站，但部分视图删除失败：${workspaceItemsDeleted.message}`,
      )
      return
    }
    options.notify.success(
      workspaceItemsDeleted.count
        ? `整个分组已移除，${workspaceItemsDeleted.count} 个视图已删除`
        : '整个分组已移入回收站',
    )
  }

  function collectEntireGroupItemIds(groupId: string): Set<string> {
    return collectWorkspaceTreeIds(
      [
        ...options.documents.value
          .filter((item) => item.documentKind === 'article')
          .map((item) => ({ id: item.id, parentId: item.parentId })),
        ...options.mindMaps.value.map((item) => ({ id: item.id, parentId: item.parentId })),
        ...options.workspaceViews.value.map((item) => ({ id: item.id, parentId: item.parentId })),
      ],
      groupId,
    )
  }

  return { deleteEntireGroup }
}
