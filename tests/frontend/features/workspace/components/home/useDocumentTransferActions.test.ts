import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import { useDocumentTransferActions } from '@/features/workspace/components/home/useDocumentTransferActions'
import type { DocumentRecord } from '@/models/documents/document'
import type { DocumentTransferService } from '@/services/documents/DocumentTransferService'

function createActions(authorize: () => Promise<boolean>) {
  const showImportModal = ref(false)
  const openFilePicker = vi.fn()
  const parseImport = vi.fn(({ fileName }: { fileName: string }) => ({
    title: fileName.replace(/\.(json|md|markdown)$/i, ''),
    format: fileName.endsWith('.json') ? ('json' as const) : ('markdown' as const),
    content: { type: 'doc', content: [] },
    plainText: fileName,
  }))
  let sequence = 0
  const createDocument = vi.fn(async (title: string, input = {}) =>
    record(`document-${++sequence}`, title, input),
  )
  const loadDocument = vi.fn()
  const actions = useDocumentTransferActions({
    getDocumentTransfer: async () => ({ parseImport }) as unknown as DocumentTransferService,
    documentSidebar: ref({ openFilePicker }),
    editor: ref(null),
    editorContent: ref({ type: 'doc', content: [] }),
    documentTitle: ref('文档'),
    currentDocument: computed(() => null),
    autosave: {
      flushBeforeDocumentChange: vi.fn(async () => ({ ok: true, value: undefined })),
    } as unknown as UseDocumentAutosaveReturn,
    actionError: ref(null),
    showImportModal,
    showShareModal: ref(false),
    authorize,
    runDocumentAction: vi.fn(async (action: () => Promise<void>) => action()),
    createDocument,
    loadDocument,
    getActiveGroupId: () => null,
    normalizeTitle: (title) => title,
    notify: { success: vi.fn(), error: vi.fn() },
  })
  return { actions, showImportModal, openFilePicker, parseImport, createDocument, loadDocument }
}

describe('useDocumentTransferActions', () => {
  it('opens the source dialog and delegates multi-file selection to the sidebar picker', async () => {
    const { actions, showImportModal, openFilePicker } = createActions(async () => true)

    actions.openImportDialog()
    expect(showImportModal.value).toBe(true)

    await actions.chooseImportSource('files')
    expect(showImportModal.value).toBe(true)
    expect(actions.importFileAccept.value).toContain('.json')
    expect(actions.importFileAccept.value).toContain('.markdown')
    expect(openFilePicker).toHaveBeenCalledWith('files')
  })

  it('opens the native picker synchronously and checks authorization before writing', async () => {
    const { actions, openFilePicker } = createActions(async () => false)
    actions.chooseImportSource('folder')
    expect(openFilePicker).toHaveBeenCalledWith('folder')

    await actions.handleImportFileChange({
      target: { value: 'selected', files: { length: 1, 0: file('one.md', '# One') } },
    })
    await actions.confirmImport(false)
    expect(actions.pendingImportFiles.value).toHaveLength(1)
  })

  it('filters a folder, proposes its name, and imports supported files into a new group', async () => {
    const { actions, showImportModal, parseImport, createDocument, loadDocument } = createActions(
      async () => true,
    )
    const input = {
      value: 'selected',
      files: {
        length: 3,
        0: file('notes/one.md', '# One'),
        1: file('notes/data.json', '{}'),
        2: file('notes/image.png', 'binary'),
      },
    }

    await actions.handleImportFileChange({ target: input })

    expect(input.value).toBe('')
    expect(actions.pendingImportFiles.value).toHaveLength(2)
    expect(actions.skippedImportFileCount.value).toBe(1)
    expect(actions.importGroupTitle.value).toBe('notes')
    expect(showImportModal.value).toBe(true)

    await actions.confirmImport(true)

    expect(parseImport).toHaveBeenCalledTimes(2)
    expect(createDocument).toHaveBeenCalledTimes(3)
    expect(createDocument.mock.calls[0]?.[1]).toMatchObject({ documentKind: 'group' })
    expect(createDocument.mock.calls[1]?.[1]).toMatchObject({ parentId: 'document-1' })
    expect(createDocument.mock.calls[2]?.[1]).toMatchObject({ parentId: 'document-1' })
    expect(loadDocument).toHaveBeenCalledWith('document-2', expect.any(Object))
    expect(showImportModal.value).toBe(false)
  })
})

function file(path: string, text: string) {
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    text: async () => text,
  }
}

function record(id: string, title: string, input: Record<string, unknown>): DocumentRecord {
  return {
    id,
    parentId: (input.parentId as string | null | undefined) ?? null,
    documentKind: (input.documentKind as 'article' | 'group' | undefined) ?? 'article',
    title,
    tags: [],
    sourceUrl: '',
    author: '',
    description: '',
    contentJson: '{"type":"doc"}',
    plainText: '',
    schemaVersion: 1,
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
