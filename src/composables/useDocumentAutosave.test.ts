import { describe, expect, it, vi } from 'vitest'

import { useDocumentAutosave, type DocumentAutosaveService } from './useDocumentAutosave'
import { DOCUMENT_SCHEMA_VERSION, EMPTY_TIPTAP_DOCUMENT, type DocumentRecord } from '@/models/document'
import { err, ok, type AppResult } from '@/models/result'

function createDocument(revision: number): DocumentRecord {
  return {
    id: 'doc-1',
    parentId: null,
    documentKind: 'article',
    title: 'Autosave',
    contentJson: JSON.stringify(EMPTY_TIPTAP_DOCUMENT),
    plainText: 'Autosave',
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    revision,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('useDocumentAutosave', () => {
  it('debounces repeated dirty marks before saving', async () => {
    vi.useFakeTimers()
    let nextRevision = 1
    const service: DocumentAutosaveService = {
      saveDocument: vi.fn(async () => ok(createDocument(nextRevision++))),
    }

    const autosave = useDocumentAutosave({
      documentId: 'doc-1',
      documentService: service,
      debounceMs: 800,
      getSnapshot: () => ({
        title: 'Autosave',
        content: EMPTY_TIPTAP_DOCUMENT,
        plainText: 'Autosave',
      }),
    })

    autosave.markDirty()
    autosave.markDirty()
    autosave.markDirty()

    await vi.advanceTimersByTimeAsync(799)
    expect(service.saveDocument).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(service.saveDocument).toHaveBeenCalledTimes(1)
    expect(autosave.status.value).toBe('saved')
    expect(autosave.dirty.value).toBe(false)
  })

  it('flushes immediately when requested', async () => {
    const service: DocumentAutosaveService = {
      saveDocument: vi.fn(async () => ok(createDocument(2))),
    }

    const autosave = useDocumentAutosave({
      documentId: 'doc-1',
      documentService: service,
      initialRevision: 1,
      getSnapshot: () => ({
        title: 'Autosave',
        content: EMPTY_TIPTAP_DOCUMENT,
        plainText: 'Autosave',
      }),
    })

    autosave.markDirty()
    const result = await autosave.flush()

    expect(result.ok).toBe(true)
    expect(service.saveDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        id: 'doc-1',
      }),
    )
    expect(autosave.revision.value).toBe(2)
    expect(autosave.status.value).toBe('saved')
  })

  it('keeps dirty state when save fails', async () => {
    const service: DocumentAutosaveService = {
      saveDocument: vi.fn(async (): Promise<AppResult<DocumentRecord>> => {
        return err({
          code: 'revision-conflict',
          message: 'stale revision',
        })
      }),
    }

    const autosave = useDocumentAutosave({
      documentId: 'doc-1',
      documentService: service,
      initialRevision: 1,
      getSnapshot: () => ({
        title: 'Autosave',
        content: EMPTY_TIPTAP_DOCUMENT,
        plainText: 'Autosave',
      }),
    })

    autosave.markDirty()
    const result = await autosave.flush()

    expect(result.ok).toBe(false)
    expect(autosave.status.value).toBe('error')
    expect(autosave.dirty.value).toBe(true)
  })

  it('does not let an older async save mark newer edits as saved', async () => {
    vi.useFakeTimers()
    let resolveSave: ((result: AppResult<DocumentRecord>) => void) | null = null
    const service: DocumentAutosaveService = {
      saveDocument: vi.fn(
        () =>
          new Promise<AppResult<DocumentRecord>>((resolve) => {
            resolveSave = resolve
          }),
      ),
    }

    const autosave = useDocumentAutosave({
      documentId: 'doc-1',
      documentService: service,
      initialRevision: 1,
      getSnapshot: () => ({
        title: 'Autosave',
        content: EMPTY_TIPTAP_DOCUMENT,
        plainText: 'Autosave',
      }),
    })

    autosave.markDirty()
    const flushPromise = autosave.flush()
    autosave.markDirty()

    resolveSave?.(ok(createDocument(2)))
    await flushPromise

    expect(autosave.status.value).toBe('dirty')
    expect(autosave.dirty.value).toBe(true)
  })

  it('ignores an older save result after a newer flush has started', async () => {
    const pendingSaves: Array<(result: AppResult<DocumentRecord>) => void> = []
    const service: DocumentAutosaveService = {
      saveDocument: vi.fn(
        () =>
          new Promise<AppResult<DocumentRecord>>((resolve) => {
            pendingSaves.push(resolve)
          }),
      ),
    }

    const autosave = useDocumentAutosave({
      documentId: 'doc-1',
      documentService: service,
      initialRevision: 1,
      getSnapshot: () => ({
        title: 'Autosave',
        content: EMPTY_TIPTAP_DOCUMENT,
        plainText: 'Autosave',
      }),
    })

    autosave.markDirty()
    const firstFlush = autosave.flush()
    autosave.markDirty()
    const secondFlush = autosave.flush()

    pendingSaves[1]?.(ok(createDocument(3)))
    await secondFlush

    expect(autosave.revision.value).toBe(3)
    expect(autosave.status.value).toBe('saved')

    pendingSaves[0]?.(ok(createDocument(2)))
    await firstFlush

    expect(autosave.revision.value).toBe(3)
    expect(autosave.status.value).toBe('saved')
  })
})
