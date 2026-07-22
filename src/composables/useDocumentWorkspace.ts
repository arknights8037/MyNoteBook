import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter, type Ref } from 'vue'

import { useDocumentAutosave } from '@/composables/useDocumentAutosave'
import { useDocumentCollection } from '@/composables/useDocumentCollection'
import { useDocumentMetadata } from '@/composables/documentWorkspace/useDocumentMetadata'
import { useDocumentTrash } from '@/composables/documentWorkspace/useDocumentTrash'
import { useDocumentTreeActions } from '@/composables/documentWorkspace/useDocumentTreeActions'
import type {
  CreateWorkspaceDocumentOptions,
  DocumentWorkspaceConfirmation,
  DocumentWorkspaceEditor,
  DocumentWorkspaceNotifier,
  DocumentWorkspaceSettings,
} from '@/composables/documentWorkspace/types'
import { ensureTopLevelBlockIds } from '@/editor/blocks/blockId'
import { parseEditorContentJson } from '@/editor/core/editorContent'
import { createInitialDocumentContent } from '@/editor/io/documentTemplate'
import { normalizeDocumentTitle } from '@/models/documents/documentPresentation'
import { createEntityId } from '@/models/shared/id'
import type {
  DocumentId,
  DocumentRecord,
  TiptapDocumentJson,
} from '@/models/documents/document'
import type { AppError } from '@/models/shared/result'
import { DocumentService } from '@/services/documents/DocumentService'

export type {
  CreateWorkspaceDocumentOptions,
  DocumentWorkspaceConfirmation,
  DocumentWorkspaceEditor,
  DocumentWorkspaceNotifier,
  DocumentWorkspaceSettings,
} from '@/composables/documentWorkspace/types'

export interface UseDocumentWorkspaceOptions {
  settings: MaybeRefOrGetter<DocumentWorkspaceSettings>
  createService: () => Promise<DocumentService>
  createId?: () => DocumentId
  initialTitle?: string
  lastDocumentStorageKey?: string
  editor?: Ref<DocumentWorkspaceEditor | null>
  notify?: DocumentWorkspaceNotifier
  confirmDelete?: DocumentWorkspaceConfirmation
  authorize?: (title: string, description: string) => Promise<boolean>
  openDocumentSurface?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

const noopNotifier: DocumentWorkspaceNotifier = {
  success: () => undefined,
  error: () => undefined,
}

export function useDocumentWorkspace(options: UseDocumentWorkspaceOptions) {
  const initialTitle = options.initialTitle ?? '未命名文档'
  const lastDocumentStorageKey = options.lastDocumentStorageKey ?? 'my-notebook:last-document'
  const createId = options.createId ?? (() => createEntityId('doc'))
  const notify = options.notify ?? noopNotifier
  const editor = options.editor ?? ref<DocumentWorkspaceEditor | null>(null)
  const storage = options.storage === undefined ? globalThis.localStorage : options.storage

  const editorContent = ref<TiptapDocumentJson>(createInitialDocumentContent(initialTitle))
  const plainText = ref(
    `${initialTitle}\n现在可以输入正文、标题、列表、引用和代码块。输入 / 打开块菜单。`,
  )
  const documentTitle = ref(initialTitle)
  const currentDocumentId = ref<DocumentId>(createId())
  const documentService = shallowRef<DocumentService | null>(null)
  const collection = useDocumentCollection()
  const {
    documents,
    deletedDocuments,
    selectedGroupId,
    replaceLists,
    mergeDocument,
    removeDocuments,
    expandDocument,
    expandGroup,
    isArticleDocument,
    revealDocument,
  } = collection

  const isLoadingDocument = ref(true)
  const isBusy = ref(false)
  const loadError = ref<AppError | null>(null)
  const actionError = ref<AppError | null>(null)
  let documentSelectionPending = false

  const currentDocument = computed(
    () => documents.value.find((document) => document.id === currentDocumentId.value) ?? null,
  )

  const autosave = useDocumentAutosave({
    documentId: currentDocumentId,
    documentService,
    getSnapshot: () => ({
      title: normalizeDocumentTitle(documentTitle.value),
      content: ensureTopLevelBlockIds(editor.value?.getJSON() ?? editorContent.value),
      plainText: editor.value?.getText() ?? plainText.value,
      parentId: currentDocument.value?.parentId ?? null,
      documentKind: currentDocument.value?.documentKind ?? 'article',
      tags: currentDocument.value?.tags ?? [],
      sourceUrl: currentDocument.value?.sourceUrl ?? '',
      author: currentDocument.value?.author ?? '',
      description: currentDocument.value?.description ?? '',
      sortOrder: currentDocument.value?.sortOrder ?? 0,
    }),
    debounceMs: () => toValue(options.settings).autosaveDelay,
    onSaved: mergeDocument,
  })

  function requireDocumentService(): DocumentService {
    if (!documentService.value) throw new Error('Document service is not ready.')
    return documentService.value
  }

  const metadata = useDocumentMetadata({
    documents,
    deletedDocuments,
    currentDocumentId,
    currentDocument,
    documentTitle,
    autosave,
    actionError,
    getService: requireDocumentService,
    runAction: runDocumentAction,
    mergeDocument,
    notify,
  })
  const {
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
    commitCurrentTitle,
    openDocumentProperties,
    resetPropertiesState,
    saveDocumentProperties,
  } = metadata

  const tree = useDocumentTreeActions({
    documents,
    selectedGroupId,
    currentDocumentId,
    isBusy,
    autosave,
    actionError,
    getService: requireDocumentService,
    runAction: runDocumentAction,
    createDocument,
    mergeDocument,
    expandGroup,
    notify,
  })
  const {
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
  } = tree

  const trash = useDocumentTrash({
    settings: options.settings,
    documents,
    deletedDocuments,
    currentDocumentId,
    initialTitle,
    autosave,
    actionError,
    getService: requireDocumentService,
    runAction: runDocumentAction,
    createDocument,
    loadDocument,
    mergeDocument,
    removeDocuments,
    notify,
    authorize: options.authorize,
    confirmDelete: options.confirmDelete,
  })
  const { deleteDocument, restoreDocument, permanentlyDeleteDocument } = trash

  async function initializeDocuments(): Promise<void> {
    isLoadingDocument.value = true
    loadError.value = null
    try {
      documentService.value = await options.createService()
      await refreshDocumentLists()

      const settings = toValue(options.settings)
      const lastDocumentId = storage?.getItem(lastDocumentStorageKey)
      const firstDocument =
        (settings.startupBehavior === 'last'
          ? documents.value.find(
              (document) => document.id === lastDocumentId && document.documentKind === 'article',
            )
          : undefined) ?? documents.value.find((document) => document.documentKind === 'article')
      if (firstDocument) {
        await loadDocument(firstDocument.id)
        return
      }

      const created = await createDocument(initialTitle)
      if (created) await loadDocument(created.id, created)
    } catch (error) {
      loadError.value = unknownError(error, 'Failed to initialize documents.')
    } finally {
      isLoadingDocument.value = false
    }
  }

  async function refreshDocumentLists(): Promise<void> {
    const service = requireDocumentService()
    const [recentResult, deletedResult] = await Promise.all([
      service.listRecentDocuments(200),
      service.listDeletedDocuments(200),
    ])
    if (!recentResult.ok) {
      actionError.value = recentResult.error
      return
    }
    if (!deletedResult.ok) {
      actionError.value = deletedResult.error
      return
    }
    replaceLists(recentResult.value, deletedResult.value)
    actionError.value = null
  }

  async function createDocument(
    title: string,
    createOptions: CreateWorkspaceDocumentOptions = {},
  ): Promise<DocumentRecord | null> {
    const normalizedTitle = normalizeDocumentTitle(title)
    const result = await requireDocumentService().saveDocument({
      id: createId(),
      expectedRevision: null,
      parentId: createOptions.parentId ?? null,
      documentKind: createOptions.documentKind ?? 'article',
      title: normalizedTitle,
      sourceUrl: createOptions.sourceUrl ?? '',
      contentJson: JSON.stringify(
        createOptions.content ?? createInitialDocumentContent(normalizedTitle),
      ),
      plainText: createOptions.plainText ?? `${normalizedTitle}\n`,
    })
    if (!result.ok) {
      actionError.value = result.error
      return null
    }
    mergeDocument(result.value)
    return result.value
  }

  async function createAndOpenDocument(parentId: DocumentId | null = null): Promise<void> {
    await createAndOpenDocumentFromContent('新文档', { parentId })
  }

  async function createAndOpenDocumentFromContent(
    title: string,
    createOptions: CreateWorkspaceDocumentOptions = {},
  ): Promise<void> {
    await runDocumentAction(async () => {
      if (!(await autosave.flushBeforeDocumentChange()).ok) return
      const created = await createDocument(title, createOptions)
      if (!created) return
      if (createOptions.parentId && isArticleDocument(createOptions.parentId)) {
        expandDocument(createOptions.parentId)
      }
      await loadDocument(created.id, created)
      options.openDocumentSurface?.()
    })
  }

  function handleEditorContentUpdate(content: TiptapDocumentJson): void {
    editorContent.value = ensureTopLevelBlockIds(content)
    if (!isLoadingDocument.value && !loadError.value) autosave.markDirty()
  }

  function handleTextUpdate(text: string): void {
    plainText.value = text
  }

  function handleTitleInput(): void {
    if (!isLoadingDocument.value && !loadError.value) autosave.markDirty()
  }

  async function loadDocument(documentId: DocumentId, loaded?: DocumentRecord): Promise<void> {
    isLoadingDocument.value = true
    loadError.value = null
    let document = loaded
    if (!document) {
      const result = await requireDocumentService().getDocument(documentId)
      if (!result.ok) {
        loadError.value = result.error
        isLoadingDocument.value = false
        return
      }
      document = result.value
    }
    if (!documents.value.some((candidate) => candidate.id === document.id)) mergeDocument(document)
    if (document.documentKind === 'group') {
      selectedGroupId.value = document.id
      expandGroup(document.id)
      isLoadingDocument.value = false
      return
    }
    currentDocumentId.value = document.id
    storage?.setItem(lastDocumentStorageKey, document.id)
    revealDocument(document.id)
    documentTitle.value = normalizeDocumentTitle(document.title)
    editorContent.value = ensureTopLevelBlockIds(parseEditorContentJson(document.contentJson))
    plainText.value = document.plainText
    autosave.resetSavedState(document.revision)
    resetRenameState()
    isLoadingDocument.value = false
  }

  async function selectDocument(documentId: DocumentId): Promise<void> {
    if (documentId === currentDocumentId.value) {
      options.openDocumentSurface?.()
      return
    }
    if (documentSelectionPending || isBusy.value) return
    documentSelectionPending = true
    try {
      if (!(await autosave.flushBeforeDocumentChange()).ok) return
      await loadDocument(documentId)
      options.openDocumentSurface?.()
    } finally {
      documentSelectionPending = false
    }
  }

  async function runDocumentAction(action: () => Promise<void>): Promise<void> {
    if (isBusy.value) return
    isBusy.value = true
    actionError.value = null
    try {
      await action()
    } catch (error) {
      actionError.value = unknownError(error, '文档操作失败。')
    } finally {
      isBusy.value = false
    }
  }

  const state = {
    editorContent,
    plainText,
    documentTitle,
    currentDocumentId,
    currentDocument,
    documents,
    deletedDocuments,
    selectedGroupId,
    isLoadingDocument,
    isBusy,
    loadError,
    actionError,
  }
  const lifecycle = {
    initialize: initializeDocuments,
    refresh: refreshDocumentLists,
    create: createDocument,
    createAndOpen: createAndOpenDocument,
    createAndOpenFromContent: createAndOpenDocumentFromContent,
    load: loadDocument,
    select: selectDocument,
    onEditorContentUpdate: handleEditorContentUpdate,
    onTextUpdate: handleTextUpdate,
    onTitleInput: handleTitleInput,
  }

  return {
    ...collection,
    state,
    lifecycle,
    metadata,
    tree,
    trash,
    editor,
    editorContent,
    plainText,
    documentTitle,
    currentDocumentId,
    currentDocument,
    documentService,
    autosave,
    isLoadingDocument,
    isBusy,
    loadError,
    actionError,
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
    draggedArticleId,
    dropTargetGroupId,
    newGroupTitle,
    showCreateGroupModal,
    initializeDocuments,
    refreshDocumentLists,
    createDocument,
    createAndOpenDocument,
    createAndOpenDocumentFromContent,
    loadDocument,
    selectDocument,
    handleEditorContentUpdate,
    handleTextUpdate,
    handleTitleInput,
    createGroup,
    confirmCreateGroup,
    startRename,
    cancelRename,
    resetRenameState,
    commitRename,
    commitCurrentTitle,
    openDocumentProperties,
    resetPropertiesState,
    saveDocumentProperties,
    handleArticleDragStart,
    handleArticleDragEnd,
    handleGroupDragOver,
    handleGroupDragLeave,
    handleGroupDrop,
    canDropArticleIntoGroup,
    moveArticleToGroup,
    deleteDocument,
    restoreDocument,
    permanentlyDeleteDocument,
    runDocumentAction,
    requireDocumentService,
  }
}

function unknownError(error: unknown, fallback: string): AppError {
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : fallback,
    cause: error,
  }
}
