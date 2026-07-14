import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'

import type { CreateWorkspaceDocumentOptions } from '@/composables/useDocumentWorkspace'
import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import type {
  DocumentId,
  DocumentRecord,
  DocumentSummary,
  TiptapDocumentJson,
} from '@/models/document'
import type { AppError } from '@/models/result'
import type { DocumentTransferService } from '@/services/DocumentTransferService'
import type { DocumentImportFormat } from '@/features/documents/documentFile'
import type { DocumentSidebarExpose, EditorShellExpose, MarkdownFileInput } from './homePageTypes'

let documentTransferPromise: Promise<DocumentTransferService> | null = null

function getDocumentTransfer(): Promise<DocumentTransferService> {
  documentTransferPromise ??= Promise.all([
    import('@/services/DocumentTransferService'),
    import('@/infrastructure/transfer/tauriDocumentTransferFilePort'),
  ]).then(
    ([{ DocumentTransferService }, { tauriDocumentTransferFilePort }]) =>
      new DocumentTransferService(tauriDocumentTransferFilePort),
  )
  return documentTransferPromise
}

interface DocumentTransferActionsOptions {
  documentSidebar: Ref<DocumentSidebarExpose | null>
  editor: Ref<EditorShellExpose | null>
  editorContent: Ref<TiptapDocumentJson>
  documentTitle: Ref<string>
  currentDocument: ComputedRef<DocumentSummary | null>
  autosave: UseDocumentAutosaveReturn
  actionError: Ref<AppError | null>
  showImportModal: Ref<boolean>
  showShareModal: Ref<boolean>
  authorize: (title: string, description: string) => Promise<boolean>
  runDocumentAction: (action: () => Promise<void>) => Promise<void>
  createDocument: (
    title: string,
    options?: CreateWorkspaceDocumentOptions,
  ) => Promise<DocumentRecord | null>
  loadDocument: (documentId: DocumentId, document?: DocumentRecord) => Promise<void>
  getActiveGroupId: () => DocumentId | null
  normalizeTitle: (title: string) => string
  notify: { success: (message: string) => void; error: (message: string) => void }
}

export function useDocumentTransferActions(options: DocumentTransferActionsOptions) {
  const selectedImportFormat = ref<DocumentImportFormat | null>(null)
  const shareHtml = ref('')
  const isPreparingShare = ref(false)
  const importFileAccept = computed(() =>
    selectedImportFormat.value === 'json'
      ? '.json,application/json'
      : '.md,.markdown,text/markdown,text/plain',
  )

  function openImportDialog(): void {
    options.showImportModal.value = true
  }

  async function chooseImportFormat(format: DocumentImportFormat): Promise<void> {
    const authorized = await options.authorize('导入文档', '导入会在知识库中创建新页面。')
    if (!authorized) return

    selectedImportFormat.value = format
    options.showImportModal.value = false
    await nextTick()
    options.documentSidebar.value?.openFilePicker()
  }

  async function handleImportFileChange(event: { target: unknown }): Promise<void> {
    const input = event.target as MarkdownFileInput
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    const importFormat = selectedImportFormat.value
    selectedImportFormat.value = null

    await options.runDocumentAction(async () => {
      const flushResult = await options.autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) return

      try {
        const documentTransfer = await getDocumentTransfer()
        const parsed = documentTransfer.parseImport({
          fileName: file.name,
          text: await file.text(),
          format: importFormat,
        })
        const created = await options.createDocument(parsed.title, {
          parentId: options.getActiveGroupId(),
          content: parsed.content,
          plainText: parsed.plainText,
        })
        if (!created) return

        await options.loadDocument(created.id, created)
        options.notify.success(parsed.format === 'json' ? 'JSON 已导入' : 'Markdown 已导入')
      } catch (error) {
        options.actionError.value = {
          code: 'validation-error',
          message: error instanceof Error ? error.message : '文件格式无法识别。',
          cause: error,
        }
        options.notify.error(options.actionError.value.message)
      }
    })
  }

  async function openShareView(): Promise<void> {
    if (isPreparingShare.value) return
    const authorized = await options.authorize(
      '分享预览',
      '分享预览会生成当前页面的可导出 Markdown 和 HTML。',
    )
    if (!authorized) return

    isPreparingShare.value = true
    try {
      const prepared = await prepareCurrentDocumentExport()
      if (!prepared) return
      shareHtml.value = prepared.html
      options.showShareModal.value = true
    } finally {
      isPreparingShare.value = false
    }
  }

  async function exportCurrentDocument(format: 'markdown' | 'html'): Promise<void> {
    const authorized = await options.authorize(
      format === 'markdown' ? '导出 Markdown' : '导出 HTML',
      '导出会把当前页面内容写入你选择的位置。',
    )
    if (!authorized) return

    const prepared = await prepareCurrentDocumentExport()
    if (!prepared) return
    const documentTransfer = await getDocumentTransfer()
    const saved = await documentTransfer.saveExport(prepared, format, '未命名文档')
    if (saved) options.notify.success(format === 'markdown' ? 'Markdown 已导出' : 'HTML 已导出')
  }

  async function prepareCurrentDocumentExport(): Promise<{
    markdown: string
    html: string
  } | null> {
    const document = options.currentDocument.value
    if (!document) return null

    const flushResult = await options.autosave.flushBeforeDocumentChange()
    if (!flushResult.ok) {
      options.notify.error('当前文档保存失败，暂不能导出')
      return null
    }

    const [{ ensureTopLevelBlockIds }, documentTransfer] = await Promise.all([
      import('@/editor/blockId'),
      getDocumentTransfer(),
    ])
    return documentTransfer.prepareExport({
      document,
      content: ensureTopLevelBlockIds(
        options.editor.value?.getJSON() ?? options.editorContent.value,
      ),
      title: options.normalizeTitle(options.documentTitle.value),
    })
  }

  return {
    shareHtml,
    isPreparingShare,
    importFileAccept,
    openImportDialog,
    chooseImportFormat,
    handleImportFileChange,
    openShareView,
    exportCurrentDocument,
  }
}
