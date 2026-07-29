import { computed, ref, type ComputedRef, type Ref } from 'vue'

import type { CreateWorkspaceDocumentOptions } from '@/composables/useDocumentWorkspace'
import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import type {
  DocumentId,
  DocumentRecord,
  DocumentSummary,
  TiptapDocumentJson,
} from '@/models/documents/document'
import type { AppError } from '@/models/shared/result'
import type { DocumentTransferService } from '@/services/documents/DocumentTransferService'
import { inferDocumentImportFormat } from '@/features/documents/documentFile'
import { createEmptyDocumentContent } from '@/editor/io/documentTemplate'
import { ensureTopLevelBlockIds } from '@/editor/blocks/blockId'
import type {
  DocumentSidebarExpose,
  EditorShellExpose,
  MarkdownFile,
  MarkdownFileInput,
} from './homePageTypes'

interface DocumentTransferActionsOptions {
  getDocumentTransfer: () => Promise<DocumentTransferService>
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
  const pendingImportFiles = ref<MarkdownFile[]>([])
  const skippedImportFileCount = ref(0)
  const importGroupTitle = ref('导入的文档')
  const isImporting = ref(false)
  const shareHtml = ref('')
  const isPreparingShare = ref(false)
  const importFileAccept = computed(() => '.json,.md,.markdown,application/json,text/markdown')

  function openImportDialog(): void {
    clearPendingImport()
    options.showImportModal.value = true
  }

  function chooseImportSource(mode: 'files' | 'folder'): void {
    // Keep this call synchronous with the user's click. Chromium may block a file chooser
    // after an awaited authorization dialog because the transient user activation is lost.
    options.documentSidebar.value?.openFilePicker(mode)
  }

  async function handleImportFileChange(event: { target: unknown }): Promise<void> {
    const input = event.target as MarkdownFileInput
    const files: MarkdownFile[] = []
    for (let index = 0; index < (input.files?.length ?? 0); index += 1) {
      const file = input.files?.[index]
      if (file) files.push(file)
    }
    // A native FileList is live in Chromium. Clear only after taking the snapshot above.
    input.value = ''
    if (!files.length) return

    const supported: MarkdownFile[] = []
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (file && inferDocumentImportFormat(file.name)) supported.push(file)
    }
    skippedImportFileCount.value = files.length - supported.length
    if (!supported.length) {
      options.notify.error('未找到可导入的 Markdown 或 JSON 文件。')
      return
    }

    pendingImportFiles.value = supported
    importGroupTitle.value = suggestImportGroupTitle(supported)
    options.showImportModal.value = true
  }

  function cancelPendingImport(): void {
    options.showImportModal.value = false
    clearPendingImport()
  }

  async function confirmImport(createGroup: boolean): Promise<void> {
    if (isImporting.value || !pendingImportFiles.value.length) return
    const authorized = await options.authorize(
      '批量导入文档',
      `即将在知识库中创建 ${pendingImportFiles.value.length} 个页面。`,
    )
    if (!authorized) return

    const files = [...pendingImportFiles.value]
    const skippedCount = skippedImportFileCount.value
    const groupTitle = options.normalizeTitle(importGroupTitle.value) || '导入的文档'
    isImporting.value = true

    await options.runDocumentAction(async () => {
      const flushResult = await options.autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) return

      try {
        const documentTransfer = await options.getDocumentTransfer()
        const parsedFiles = []
        let failedCount = 0
        for (const file of files) {
          try {
            parsedFiles.push({
              file,
              parsed: documentTransfer.parseImport({
                fileName: file.name,
                text: await file.text(),
              }),
            })
          } catch {
            failedCount += 1
          }
        }
        if (!parsedFiles.length) {
          options.notify.error('所选文件均无法解析，请检查文件内容。')
          return
        }

        let parentId = options.getActiveGroupId()
        if (createGroup) {
          const group = await options.createDocument(groupTitle, {
            documentKind: 'group',
            content: createEmptyDocumentContent(),
            plainText: '',
          })
          if (!group) return
          parentId = group.id
        }

        const createdDocuments: DocumentRecord[] = []
        for (const { file, parsed } of parsedFiles) {
          const created = await options.createDocument(parsed.title, {
            parentId,
            content: parsed.content,
            plainText: parsed.plainText,
            sourceUrl: file.path || file.webkitRelativePath || file.name,
          })
          if (created) createdDocuments.push(created)
          else failedCount += 1
        }
        if (!createdDocuments.length) return

        await options.loadDocument(createdDocuments[0]!.id, createdDocuments[0])
        const ignoredCount = skippedCount + failedCount
        options.notify.success(
          ignoredCount
            ? `已导入 ${createdDocuments.length} 个文档，跳过 ${ignoredCount} 个文件`
            : `已导入 ${createdDocuments.length} 个文档`,
        )
      } catch (error) {
        options.actionError.value = {
          code: 'validation-error',
          message: error instanceof Error ? error.message : '文件格式无法识别。',
          cause: error,
        }
        options.notify.error(options.actionError.value.message)
      }
    })
    isImporting.value = false
    options.showImportModal.value = false
    clearPendingImport()
  }

  function clearPendingImport(): void {
    pendingImportFiles.value = []
    skippedImportFileCount.value = 0
    importGroupTitle.value = '导入的文档'
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
    const documentTransfer = await options.getDocumentTransfer()
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

    const documentTransfer = await options.getDocumentTransfer()
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
    pendingImportFiles,
    skippedImportFileCount,
    importGroupTitle,
    isImporting,
    openImportDialog,
    chooseImportSource,
    handleImportFileChange,
    cancelPendingImport,
    confirmImport,
    openShareView,
    exportCurrentDocument,
  }
}

function suggestImportGroupTitle(files: MarkdownFile[]): string {
  const folderName = files
    .map((file) => file.webkitRelativePath?.split(/[\\/]/)[0]?.trim())
    .find((name) => name)
  return folderName || '导入的文档'
}
