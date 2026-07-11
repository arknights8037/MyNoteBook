import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import { useDocumentTransferActions } from './useDocumentTransferActions'

function createActions(authorize: () => Promise<boolean>) {
  const showImportModal = ref(false)
  const openFilePicker = vi.fn()
  const actions = useDocumentTransferActions({
    documentSidebar: ref({ openFilePicker }),
    editor: ref(null),
    editorContent: ref({ type: 'doc', content: [] }),
    documentTitle: ref('文档'),
    currentDocument: computed(() => null),
    autosave: {} as UseDocumentAutosaveReturn,
    actionError: ref(null),
    showImportModal,
    showShareModal: ref(false),
    authorize,
    runDocumentAction: vi.fn(),
    createDocument: vi.fn(),
    loadDocument: vi.fn(),
    getActiveGroupId: () => null,
    normalizeTitle: (title) => title,
    notify: { success: vi.fn(), error: vi.fn() },
  })
  return { actions, showImportModal, openFilePicker }
}

describe('useDocumentTransferActions', () => {
  it('opens the format dialog and then delegates to the sidebar file picker', async () => {
    const { actions, showImportModal, openFilePicker } = createActions(async () => true)

    actions.openImportDialog()
    expect(showImportModal.value).toBe(true)

    await actions.chooseImportFormat('json')
    expect(showImportModal.value).toBe(false)
    expect(actions.importFileAccept.value).toBe('.json,application/json')
    expect(openFilePicker).toHaveBeenCalledOnce()
  })

  it('keeps the picker closed when authorization is rejected', async () => {
    const { actions, openFilePicker } = createActions(async () => false)
    await actions.chooseImportFormat('markdown')
    expect(openFilePicker).not.toHaveBeenCalled()
  })
})
