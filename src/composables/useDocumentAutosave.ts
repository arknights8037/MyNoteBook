import { onBeforeUnmount, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue'

import { serializeEditorContent } from '@/editor/editorContent'
import type {
  DocumentId,
  DocumentKind,
  DocumentRecord,
  SaveDocumentInput,
  TiptapDocumentJson,
} from '@/models/document'
import { err, ok, type AppError, type AppResult } from '@/models/result'

export type AutosaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

export interface DocumentAutosaveSnapshot {
  title: string
  content: TiptapDocumentJson
  plainText: string
  parentId?: DocumentId | null
  documentKind?: DocumentKind
  sortOrder?: number
}

export interface DocumentAutosaveService {
  saveDocument(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>>
}

export interface UseDocumentAutosaveOptions {
  documentId: MaybeRefOrGetter<DocumentId>
  documentService: MaybeRefOrGetter<DocumentAutosaveService | null>
  getSnapshot: () => DocumentAutosaveSnapshot | null
  debounceMs?: number
  initialRevision?: MaybeRefOrGetter<number | null>
}

export interface UseDocumentAutosaveReturn {
  status: Ref<AutosaveStatus>
  error: Ref<AppError | null>
  dirty: Ref<boolean>
  saving: Ref<boolean>
  revision: Ref<number | null>
  markDirty: () => void
  flush: () => Promise<AppResult<DocumentRecord | null>>
  flushBeforeDocumentChange: () => Promise<AppResult<DocumentRecord | null>>
  resetSavedState: (revision: number | null) => void
}

export function useDocumentAutosave(
  options: UseDocumentAutosaveOptions,
): UseDocumentAutosaveReturn {
  const status = ref<AutosaveStatus>('saved')
  const error = ref<AppError | null>(null)
  const dirty = ref(false)
  const saving = ref(false)
  const revision = ref<number | null>(toValue(options.initialRevision) ?? null)
  const debounceMs = options.debounceMs ?? 800

  let timer: ReturnType<typeof setTimeout> | null = null
  let dirtyVersion = 0
  let saveSequence = 0

  function clearPendingTimer(): void {
    if (timer === null) {
      return
    }

    clearTimeout(timer)
    timer = null
  }

  function scheduleFlush(): void {
    clearPendingTimer()
    timer = setTimeout(() => {
      void flush()
    }, debounceMs)
  }

  function markDirty(): void {
    dirty.value = true
    dirtyVersion += 1
    status.value = 'dirty'
    error.value = null
    scheduleFlush()
  }

  async function flush(): Promise<AppResult<DocumentRecord | null>> {
    clearPendingTimer()

    if (!dirty.value) {
      return ok(null)
    }

    const documentService = toValue(options.documentService)
    if (!documentService) {
      const appError: AppError = {
        code: 'database-unavailable',
        message: 'Document service is not ready.',
      }
      error.value = appError
      status.value = 'error'
      return err(appError)
    }

    const snapshot = options.getSnapshot()
    if (!snapshot) {
      const appError: AppError = {
        code: 'validation-error',
        message: 'Editor snapshot is not available.',
      }
      error.value = appError
      status.value = 'error'
      return err(appError)
    }

    const capturedDirtyVersion = dirtyVersion
    const currentSaveSequence = ++saveSequence
    saving.value = true
    status.value = 'saving'

    const saveResult = await documentService.saveDocument({
      id: toValue(options.documentId),
      expectedRevision: revision.value,
      parentId: snapshot.parentId ?? null,
      documentKind: snapshot.documentKind ?? 'article',
      title: snapshot.title,
      contentJson: serializeEditorContent(snapshot.content),
      plainText: snapshot.plainText,
      sortOrder: snapshot.sortOrder ?? 0,
    })

    if (currentSaveSequence === saveSequence) {
      saving.value = false
    }

    if (currentSaveSequence !== saveSequence) {
      return saveResult
    }

    if (!saveResult.ok) {
      error.value = saveResult.error
      status.value = 'error'
      dirty.value = true
      return saveResult
    }

    revision.value = saveResult.value.revision
    error.value = null

    if (capturedDirtyVersion === dirtyVersion) {
      dirty.value = false
      status.value = 'saved'
    } else {
      dirty.value = true
      status.value = 'dirty'
      scheduleFlush()
    }

    return saveResult
  }

  function resetSavedState(nextRevision: number | null): void {
    clearPendingTimer()
    revision.value = nextRevision
    dirty.value = false
    saving.value = false
    status.value = 'saved'
    error.value = null
    dirtyVersion += 1
  }

  function handleBeforeUnload(): void {
    if (dirty.value) {
      void flush()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }

  onBeforeUnmount(() => {
    clearPendingTimer()
    if (dirty.value) {
      void flush()
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  })

  return {
    status,
    error,
    dirty,
    saving,
    revision,
    markDirty,
    flush,
    flushBeforeDocumentChange: flush,
    resetSavedState,
  }
}
