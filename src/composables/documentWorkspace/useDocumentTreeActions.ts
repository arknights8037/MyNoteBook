import { ref, type Ref } from 'vue'

import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import { createEmptyDocumentContent } from '@/editor/io/documentTemplate'
import {
  displayDocumentTitle,
  normalizeDocumentTitle,
} from '@/models/documents/documentPresentation'
import type { DocumentId, DocumentRecord, DocumentSummary } from '@/models/documents/document'
import type { AppError } from '@/models/shared/result'
import type { DocumentService } from '@/services/documents/DocumentService'
import type { CreateWorkspaceDocumentOptions, DocumentWorkspaceNotifier } from './types'

interface UseDocumentTreeActionsOptions {
  documents: Ref<DocumentSummary[]>
  selectedGroupId: Ref<DocumentId | null>
  currentDocumentId: Ref<DocumentId>
  isBusy: Ref<boolean>
  autosave: UseDocumentAutosaveReturn
  actionError: Ref<AppError | null>
  getService: () => DocumentService
  runAction: (action: () => Promise<void>) => Promise<void>
  createDocument: (
    title: string,
    options?: CreateWorkspaceDocumentOptions,
  ) => Promise<DocumentRecord | null>
  mergeDocument: (document: DocumentRecord) => void
  expandGroup: (groupId: DocumentId) => void
  notify: DocumentWorkspaceNotifier
}

export function useDocumentTreeActions(options: UseDocumentTreeActionsOptions) {
  const draggedArticleId = ref<DocumentId | null>(null)
  const dropTargetGroupId = ref<DocumentId | null>(null)
  const newGroupTitle = ref('新分组')
  const showCreateGroupModal = ref(false)

  function createGroup(): void {
    newGroupTitle.value = '新分组'
    showCreateGroupModal.value = true
  }

  async function confirmCreateGroup(): Promise<void> {
    const title = normalizeDocumentTitle(newGroupTitle.value)
    showCreateGroupModal.value = false
    await options.runAction(async () => {
      if (!(await options.autosave.flushBeforeDocumentChange()).ok) return
      const created = await options.createDocument(title, {
        documentKind: 'group',
        content: createEmptyDocumentContent(),
        plainText: '',
      })
      if (!created) return
      options.selectedGroupId.value = created.id
      options.expandGroup(created.id)
      options.notify.success('分组已创建')
    })
  }

  function handleArticleDragStart(event: DragEvent, document: DocumentSummary): void {
    if (options.isBusy.value || document.documentKind !== 'article') {
      event.preventDefault()
      return
    }
    draggedArticleId.value = document.id
    event.dataTransfer?.setData('text/plain', document.id)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.dropEffect = 'move'
    }
  }

  function handleArticleDragEnd(): void {
    draggedArticleId.value = null
    dropTargetGroupId.value = null
  }

  function canDropArticleIntoGroup(groupId: DocumentId): boolean {
    const article = options.documents.value.find(
      (document) => document.id === draggedArticleId.value,
    )
    return article?.documentKind === 'article' && article.parentId !== groupId
  }

  function handleGroupDragOver(event: DragEvent, groupId: DocumentId): void {
    if (!canDropArticleIntoGroup(groupId)) return
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropTargetGroupId.value = groupId
  }

  function handleGroupDragLeave(event: DragEvent, groupId: DocumentId): void {
    const target = event.currentTarget
    const relatedTarget = event.relatedTarget
    if (
      target instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      target.contains(relatedTarget)
    ) {
      return
    }
    if (dropTargetGroupId.value === groupId) dropTargetGroupId.value = null
  }

  async function handleGroupDrop(event: DragEvent, groupId: DocumentId): Promise<void> {
    event.preventDefault()
    const articleId = draggedArticleId.value ?? event.dataTransfer?.getData('text/plain') ?? null
    handleArticleDragEnd()
    if (!articleId) return
    const article = options.documents.value.find(
      (document) => document.id === articleId && document.documentKind === 'article',
    )
    if (article && article.parentId !== groupId) await moveArticleToGroup(article, groupId)
  }

  async function moveArticleToGroup(article: DocumentSummary, groupId: DocumentId): Promise<void> {
    await options.runAction(async () => {
      const target = options.documents.value.find((document) => document.id === groupId)
      if (article.id === options.currentDocumentId.value) {
        const flush = await options.autosave.flushBeforeDocumentChange()
        if (!flush.ok) return options.notify.error(flush.error.message)
      }
      const revision = revisionFor(article, options.autosave, options.currentDocumentId.value)
      if (revision === null) return options.notify.error('文章版本尚未就绪，请稍后重试。')
      const result = await options.getService().updateDocument({
        id: article.id,
        expectedRevision: revision,
        parentId: groupId,
      })
      if (!result.ok) {
        options.actionError.value = result.error
        return options.notify.error(result.error.message)
      }
      if (article.id === options.currentDocumentId.value) {
        options.autosave.resetSavedState(result.value.revision)
      }
      options.selectedGroupId.value = groupId
      options.expandGroup(groupId)
      options.mergeDocument(result.value)
      options.notify.success(`已移动到「${target ? displayDocumentTitle(target) : '分组'}」`)
    })
  }

  const groups = {
    title: newGroupTitle,
    showCreate: showCreateGroupModal,
    create: createGroup,
    confirmCreate: confirmCreateGroup,
  }
  const dragDrop = {
    draggedArticleId,
    dropTargetGroupId,
    start: handleArticleDragStart,
    end: handleArticleDragEnd,
    dragOverGroup: handleGroupDragOver,
    dragLeaveGroup: handleGroupDragLeave,
    dropOnGroup: handleGroupDrop,
    canDropIntoGroup: canDropArticleIntoGroup,
    moveToGroup: moveArticleToGroup,
  }

  return {
    groups,
    dragDrop,
    draggedArticleId,
    dropTargetGroupId,
    newGroupTitle,
    showCreateGroupModal,
    createGroup,
    confirmCreateGroup,
    handleArticleDragStart,
    handleArticleDragEnd,
    handleGroupDragOver,
    handleGroupDragLeave,
    handleGroupDrop,
    canDropArticleIntoGroup,
    moveArticleToGroup,
  }
}

function revisionFor(
  document: DocumentSummary,
  autosave: UseDocumentAutosaveReturn,
  currentDocumentId: DocumentId,
): number | null {
  return document.id === currentDocumentId ? autosave.revision.value : document.revision
}
