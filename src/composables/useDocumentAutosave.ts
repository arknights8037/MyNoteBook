import { onBeforeUnmount, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue'

import { serializeEditorContent } from '@/editor/core/editorContent'
import type {
  DocumentId,
  DocumentKind,
  DocumentRecord,
  SaveDocumentInput,
  TiptapDocumentJson,
} from '@/models/documents/document'
import { err, ok, type AppError, type AppResult } from '@/models/shared/result'

export type AutosaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

export interface DocumentAutosaveSnapshot {
  title: string
  content: TiptapDocumentJson
  plainText: string
  parentId?: DocumentId | null
  documentKind?: DocumentKind
  tags?: string[]
  sourceUrl?: string
  author?: string
  description?: string
  sortOrder?: number
}

export interface DocumentAutosaveService {
  saveDocument(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>>
}

export interface UseDocumentAutosaveOptions {
  documentId: MaybeRefOrGetter<DocumentId>
  documentService: MaybeRefOrGetter<DocumentAutosaveService | null>
  getSnapshot: () => DocumentAutosaveSnapshot | null
  debounceMs?: MaybeRefOrGetter<number>
  initialRevision?: MaybeRefOrGetter<number | null>
  onSaved?: (document: DocumentRecord) => void
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
  let activeFlush: Promise<AppResult<DocumentRecord | null>> | null = null
  let allowWindowClose = false
  let disposed = false
  let unlistenWindowClose: (() => void) | null = null

  function clearPendingTimer(): void {
    if (timer === null) {
      return
    }

    clearTimeout(timer)
    timer = null
  }

  function scheduleFlush(): void {
    clearPendingTimer()
    timer = setTimeout(
      () => {
        void flush()
      },
      Math.max(0, toValue(debounceMs)),
    )
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

    if (activeFlush) return activeFlush

    activeFlush = runFlushLoop().finally(() => {
      activeFlush = null
    })
    return activeFlush
  }

  async function runFlushLoop(): Promise<AppResult<DocumentRecord | null>> {
    let latestResult: AppResult<DocumentRecord | null> = ok(null)

    while (dirty.value) {
      const result = await saveCurrentSnapshot()
      latestResult = result
      if (!result.ok) return result
    }

    return latestResult
  }

  async function saveCurrentSnapshot(): Promise<AppResult<DocumentRecord | null>> {
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
    saving.value = true
    status.value = 'saving'

    const saveResult = await documentService.saveDocument({
      id: toValue(options.documentId),
      expectedRevision: revision.value,
      parentId: snapshot.parentId ?? null,
      documentKind: snapshot.documentKind ?? 'article',
      title: snapshot.title,
      tags: snapshot.tags,
      sourceUrl: snapshot.sourceUrl,
      author: snapshot.author,
      description: snapshot.description,
      contentJson: serializeEditorContent(snapshot.content),
      plainText: snapshot.plainText,
      sortOrder: snapshot.sortOrder ?? 0,
    })

    saving.value = false

    if (!saveResult.ok) {
      error.value = saveResult.error
      status.value = 'error'
      dirty.value = true
      return saveResult
    }

    options.onSaved?.(saveResult.value)
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

  function handleBeforeUnload(event: BeforeUnloadEvent): void {
    if (dirty.value) {
      // Browser unload handlers cannot await SQLite writes. Keep the page alive and let the
      // Tauri close-request handler below finish the flush before closing the native window.
      event.preventDefault()
      void flush()
    }
  }

  if (typeof window !== 'undefined') {
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow()
        const unlisten = await appWindow.onCloseRequested(async (event) => {
          if (allowWindowClose || !dirty.value) return
          event.preventDefault()
          const result = await flush()
          if (result.ok && !dirty.value) {
            allowWindowClose = true
            await appWindow.close()
          }
        })
        if (disposed) unlisten()
        else unlistenWindowClose = unlisten
      })
      .catch(() => {
        // Browser development and unit tests do not expose a native Tauri window.
      })
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }

  onBeforeUnmount(() => {
    disposed = true
    unlistenWindowClose?.()
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
