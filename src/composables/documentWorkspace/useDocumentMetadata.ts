import { computed, ref, type ComputedRef, type Ref } from 'vue'

import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import {
  displayDocumentTitle,
  normalizeDocumentTitle,
  parseDocumentTags,
} from '@/features/documents/documentPresentation'
import type { DocumentId, DocumentRecord, DocumentSummary } from '@/models/document'
import type { AppError } from '@/models/result'
import type { DocumentService } from '@/services/DocumentService'
import type { DocumentWorkspaceNotifier } from './types'

interface UseDocumentMetadataOptions {
  documents: Ref<DocumentSummary[]>
  deletedDocuments: Ref<DocumentSummary[]>
  currentDocumentId: Ref<DocumentId>
  currentDocument: ComputedRef<DocumentSummary | null>
  documentTitle: Ref<string>
  autosave: UseDocumentAutosaveReturn
  actionError: Ref<AppError | null>
  getService: () => DocumentService
  runAction: (action: () => Promise<void>) => Promise<void>
  mergeDocument: (document: DocumentRecord) => void
  notify: DocumentWorkspaceNotifier
}

export function useDocumentMetadata(options: UseDocumentMetadataOptions) {
  const renamingDocumentId = ref<DocumentId | null>(null)
  const renameTitle = ref('')
  const showRenameModal = ref(false)
  const propertiesDocumentId = ref<DocumentId | null>(null)
  const showPropertiesModal = ref(false)
  const propertiesDraftTags = ref('')
  const propertiesDraftSourceUrl = ref('')
  const propertiesDraftAuthor = ref('')
  const propertiesDraftDescription = ref('')
  const isSavingProperties = ref(false)

  const renamingDocument = computed(
    () =>
      options.documents.value.find((document) => document.id === renamingDocumentId.value) ?? null,
  )
  const propertiesDocument = computed(
    () =>
      [...options.documents.value, ...options.deletedDocuments.value].find(
        (document) => document.id === propertiesDocumentId.value,
      ) ?? null,
  )

  function startRename(document: DocumentSummary): void {
    renamingDocumentId.value = document.id
    renameTitle.value = displayDocumentTitle(document)
    showRenameModal.value = true
  }

  function cancelRename(): void {
    showRenameModal.value = false
    resetRenameState()
  }

  function resetRenameState(): void {
    renamingDocumentId.value = null
    renameTitle.value = ''
  }

  async function commitRename(): Promise<void> {
    const document = renamingDocument.value
    if (!document) return cancelRename()
    const title = normalizeDocumentTitle(renameTitle.value)
    if (title === displayDocumentTitle(document)) return cancelRename()

    await options.runAction(async () => {
      if (document.id === options.currentDocumentId.value) {
        const flush = await options.autosave.flushBeforeDocumentChange()
        if (!flush.ok) {
          options.actionError.value = flush.error
          options.notify.error(flush.error.message)
          return
        }
      }
      const revision = revisionFor(document, options.autosave, options.currentDocumentId.value)
      if (revision === null) return setRevisionError('当前文档还没有可用于重命名的 revision。')
      const result = await options.getService().updateDocument({
        id: document.id,
        expectedRevision: revision,
        title,
      })
      if (!result.ok) {
        options.actionError.value = result.error
        return
      }
      if (document.id === options.currentDocumentId.value) {
        options.documentTitle.value = result.value.title
        options.autosave.resetSavedState(result.value.revision)
      }
      cancelRename()
      options.mergeDocument(result.value)
    })
  }

  async function commitCurrentTitle(): Promise<void> {
    const document = options.currentDocument.value
    if (!document) return
    const title = normalizeDocumentTitle(options.documentTitle.value)
    options.documentTitle.value = title
    if (title === displayDocumentTitle(document)) return

    await options.runAction(async () => {
      const flush = await options.autosave.flushBeforeDocumentChange()
      if (!flush.ok) return
      if (flush.value && normalizeDocumentTitle(flush.value.title) === title) {
        options.documentTitle.value = normalizeDocumentTitle(flush.value.title)
        return
      }
      if (options.autosave.revision.value === null) {
        return setRevisionError('当前文档还没有可用于重命名的 revision。')
      }
      const result = await options.getService().updateDocument({
        id: document.id,
        expectedRevision: options.autosave.revision.value,
        title,
      })
      if (!result.ok) {
        options.actionError.value = result.error
        return
      }
      options.documentTitle.value = result.value.title
      options.autosave.resetSavedState(result.value.revision)
      options.mergeDocument(result.value)
    })
  }

  function openDocumentProperties(document: DocumentSummary): void {
    propertiesDocumentId.value = document.id
    propertiesDraftTags.value = document.tags.join('、')
    propertiesDraftSourceUrl.value = document.sourceUrl
    propertiesDraftAuthor.value = document.author
    propertiesDraftDescription.value = document.description
    showPropertiesModal.value = true
  }

  function resetPropertiesState(): void {
    propertiesDocumentId.value = null
    propertiesDraftTags.value = ''
    propertiesDraftSourceUrl.value = ''
    propertiesDraftAuthor.value = ''
    propertiesDraftDescription.value = ''
    isSavingProperties.value = false
  }

  async function saveDocumentProperties(): Promise<void> {
    const document = propertiesDocument.value
    if (!document || isSavingProperties.value) return
    isSavingProperties.value = true
    try {
      if (!(await options.autosave.flushBeforeDocumentChange()).ok) {
        options.notify.error('当前文档保存失败，属性未更新')
        return
      }
      const latest = [...options.documents.value, ...options.deletedDocuments.value].find(
        (candidate) => candidate.id === document.id,
      )
      const result = await options.getService().updateDocument({
        id: document.id,
        expectedRevision: latest?.revision ?? document.revision,
        tags: parseDocumentTags(propertiesDraftTags.value),
        sourceUrl: propertiesDraftSourceUrl.value.trim(),
        author: propertiesDraftAuthor.value.trim(),
        description: propertiesDraftDescription.value.trim(),
      })
      if (!result.ok) {
        options.actionError.value = result.error
        options.notify.error(result.error.message)
        return
      }
      options.mergeDocument(result.value)
      if (result.value.id === options.currentDocumentId.value) {
        options.autosave.resetSavedState(result.value.revision)
      }
      showPropertiesModal.value = false
      options.notify.success('属性已保存')
    } finally {
      isSavingProperties.value = false
    }
  }

  function setRevisionError(message: string): void {
    options.actionError.value = { code: 'revision-conflict', message }
  }

  const rename = {
    documentId: renamingDocumentId,
    document: renamingDocument,
    title: renameTitle,
    show: showRenameModal,
    start: startRename,
    cancel: cancelRename,
    reset: resetRenameState,
    commit: commitRename,
  }
  const properties = {
    documentId: propertiesDocumentId,
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
  }

  return {
    rename,
    properties,
    commitCurrentTitle,
    renamingDocumentId,
    renamingDocument,
    renameTitle,
    showRenameModal,
    propertiesDocumentId,
    propertiesDocument,
    showPropertiesModal,
    propertiesDraftTags,
    propertiesDraftSourceUrl,
    propertiesDraftAuthor,
    propertiesDraftDescription,
    isSavingProperties,
    startRename,
    cancelRename,
    resetRenameState,
    commitRename,
    openDocumentProperties,
    resetPropertiesState,
    saveDocumentProperties,
  }
}

function revisionFor(
  document: DocumentSummary,
  autosave: UseDocumentAutosaveReturn,
  currentDocumentId: DocumentId,
): number | null {
  return document.id === currentDocumentId ? autosave.revision.value : document.revision
}
