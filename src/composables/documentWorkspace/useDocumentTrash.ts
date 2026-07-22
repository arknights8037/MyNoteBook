import { toValue, type MaybeRefOrGetter, type Ref } from 'vue'

import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import { displayDocumentTitle } from '@/models/documents/documentPresentation'
import { collectArticleDescendants } from '@/models/documents/documentTree'
import type { DocumentId, DocumentRecord, DocumentSummary } from '@/models/documents/document'
import type { AppError } from '@/models/shared/result'
import type { DocumentService } from '@/services/documents/DocumentService'
import type {
  CreateWorkspaceDocumentOptions,
  DocumentWorkspaceConfirmation,
  DocumentWorkspaceNotifier,
  DocumentWorkspaceSettings,
} from './types'

interface UseDocumentTrashOptions {
  settings: MaybeRefOrGetter<DocumentWorkspaceSettings>
  documents: Ref<DocumentSummary[]>
  deletedDocuments: Ref<DocumentSummary[]>
  currentDocumentId: Ref<DocumentId>
  initialTitle: string
  autosave: UseDocumentAutosaveReturn
  actionError: Ref<AppError | null>
  getService: () => DocumentService
  runAction: (action: () => Promise<void>) => Promise<void>
  createDocument: (
    title: string,
    options?: CreateWorkspaceDocumentOptions,
  ) => Promise<DocumentRecord | null>
  loadDocument: (documentId: DocumentId, document?: DocumentRecord) => Promise<void>
  mergeDocument: (document: DocumentRecord) => void
  removeDocuments: (documentIds: Iterable<DocumentId>) => void
  notify: DocumentWorkspaceNotifier
  authorize?: (title: string, description: string) => Promise<boolean>
  confirmDelete?: DocumentWorkspaceConfirmation
}

export function useDocumentTrash(options: UseDocumentTrashOptions) {
  async function deleteDocument(document: DocumentSummary): Promise<void> {
    const descendants = collectArticleDescendants(options.documents.value, document.id)
    if (!(await confirmRemoval(document, descendants.length, false))) return
    if (!(await authorize('删除页面', `即将把「${displayDocumentTitle(document)}」移入回收站。`))) {
      return
    }

    await options.runAction(async () => {
      const targets = [document, ...descendants]
      const deletingCurrent = targets.some(
        (candidate) => candidate.id === options.currentDocumentId.value,
      )
      if (deletingCurrent && !(await options.autosave.flushBeforeDocumentChange()).ok) return

      for (const candidate of [...targets].reverse()) {
        const revision = revisionFor(candidate, options.autosave, options.currentDocumentId.value)
        if (revision === null) return options.notify.error('文档版本尚未就绪，请稍后重试。')
        const result = await options.getService().deleteDocument(candidate.id, revision)
        if (!result.ok) {
          options.actionError.value = result.error
          return options.notify.error(result.error.message)
        }
        options.mergeDocument(result.value)
      }

      if (deletingCurrent) {
        const next = options.documents.value.find(
          (candidate) => candidate.documentKind === 'article',
        )
        const target = next ?? (await options.createDocument(options.initialTitle))
        if (target)
          await options.loadDocument(target.id, 'contentJson' in target ? target : undefined)
      }
      options.notify.success(
        descendants.length
          ? `页面及 ${descendants.length} 个子页面已移入回收站`
          : '页面已移入回收站',
      )
    })
  }

  async function restoreDocument(document: DocumentSummary): Promise<void> {
    if (!(await authorize('恢复页面', `即将从回收站恢复「${displayDocumentTitle(document)}」。`))) {
      return
    }

    await options.runAction(async () => {
      const descendants = collectArticleDescendants(options.deletedDocuments.value, document.id)
      let restored: DocumentRecord | null = null
      for (const candidate of [document, ...descendants]) {
        const result = await options.getService().restoreDocument(candidate.id, candidate.revision)
        if (!result.ok) {
          options.actionError.value = result.error
          return options.notify.error(result.error.message)
        }
        options.mergeDocument(result.value)
        if (candidate.id === document.id) restored = result.value
      }
      if (restored) await options.loadDocument(restored.id, restored)
      options.notify.success(descendants.length ? '页面及其子页面已恢复' : '页面已恢复')
    })
  }

  async function permanentlyDeleteDocument(document: DocumentSummary): Promise<void> {
    const descendants = collectArticleDescendants(options.deletedDocuments.value, document.id)
    if (!(await confirmRemoval(document, descendants.length, true))) return
    if (
      !(await authorize(
        '彻底删除页面',
        `即将彻底删除「${displayDocumentTitle(document)}」，此操作无法恢复。`,
      ))
    ) {
      return
    }

    await options.runAction(async () => {
      for (const candidate of [document, ...descendants].reverse()) {
        const result = await options
          .getService()
          .permanentlyDeleteDocument(candidate.id, candidate.revision)
        if (!result.ok) {
          options.actionError.value = result.error
          return options.notify.error(result.error.message)
        }
        options.removeDocuments([candidate.id])
      }
      options.notify.success(descendants.length ? '页面及其子页面已彻底删除' : '页面已彻底删除')
    })
  }

  function authorize(title: string, description: string): Promise<boolean> {
    return options.authorize?.(title, description) ?? Promise.resolve(true)
  }

  function confirmRemoval(
    document: DocumentSummary,
    descendantCount: number,
    permanent: boolean,
  ): Promise<boolean> {
    if (!toValue(options.settings).confirmBeforeDelete) return Promise.resolve(true)
    return options.confirmDelete?.(document, descendantCount, permanent) ?? Promise.resolve(false)
  }

  return {
    delete: deleteDocument,
    restore: restoreDocument,
    permanentlyDelete: permanentlyDeleteDocument,
    deleteDocument,
    restoreDocument,
    permanentlyDeleteDocument,
  }
}

function revisionFor(
  document: DocumentSummary,
  autosave: UseDocumentAutosaveReturn,
  currentDocumentId: DocumentId,
): number | null {
  return document.id === currentDocumentId ? autosave.revision.value : document.revision
}
