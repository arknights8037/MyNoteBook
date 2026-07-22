import { nextTick, type Ref } from 'vue'

import type { UseAiConversationReturn } from '@/composables/useAiConversation'
import type { AppError } from '@/models/shared/result'
import type { DocumentId, DocumentRecord } from '@/models/documents/document'
import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import type { CreateWorkspaceDocumentOptions } from '@/composables/useDocumentWorkspace'
import type { EditorShellExpose } from './homePageTypes'

interface HomeAiMessageActionsOptions {
  conversation: UseAiConversationReturn
  showChat: Ref<boolean>
  editor: Ref<EditorShellExpose | null>
  currentDocumentId: Ref<DocumentId>
  autosave: UseDocumentAutosaveReturn
  actionError: Ref<AppError | null>
  runAssistant: () => Promise<void>
  runDocumentAction: (action: () => Promise<void>) => Promise<void>
  selectDocument: (documentId: DocumentId) => Promise<void>
  createDocument: (
    title: string,
    options?: CreateWorkspaceDocumentOptions,
  ) => Promise<DocumentRecord | null>
  loadDocument: (documentId: DocumentId, document?: DocumentRecord) => Promise<void>
  expandDocument: (documentId: DocumentId) => void
  notify: { success: (message: string) => void; error: (message: string) => void }
}

export function useHomeAiMessageActions(options: HomeAiMessageActionsOptions) {
  function openChat(): void {
    options.showChat.value = true
    if (!options.conversation.prompt.value.trim()) {
      options.conversation.prompt.value = '请根据当前文档，整理一版结构清晰的 Markdown 摘要。'
    }
  }

  async function retryMessage(messageId: string): Promise<void> {
    if (options.conversation.prepareRetry(messageId)) await options.runAssistant()
  }

  function insertMessage(content: string): void {
    if (!content.trim()) return
    options.editor.value?.insertMarkdown(content)
    options.notify.success('AI 回复已插入文档')
  }

  async function openSourceDocument(documentId: string, blockId?: string): Promise<void> {
    if (!documentId.trim()) return
    await options.selectDocument(documentId)
    await nextTick()
    const revealed = blockId ? options.editor.value?.revealBlock(blockId) : false
    options.notify.success(revealed ? '已定位到来源内容' : '已打开来源文档')
  }

  async function openEditorDocument(documentId: string, blockId?: string): Promise<void> {
    await options.selectDocument(documentId)
    if (!blockId) return
    await nextTick()
    options.editor.value?.revealBlock(blockId)
  }

  async function copyMessage(content: string): Promise<void> {
    const text = content.trim()
    if (!text) return

    try {
      await globalThis.navigator?.clipboard?.writeText(text)
      options.notify.success('AI 回复已复制')
    } catch {
      options.notify.error('复制失败，请手动复制')
    }
  }

  async function writeMessageToChildDocument(content: string): Promise<void> {
    const markdown = content.trim()
    if (!markdown) return

    await options.runDocumentAction(async () => {
      const flushResult = await options.autosave.flushBeforeDocumentChange()
      if (!flushResult.ok) {
        options.actionError.value = flushResult.error
        options.notify.error('当前文档保存失败，暂不能写入子页面')
        return
      }

      const { parseMarkdownDocument } = await import('@/editor/io/markdownImport')
      const imported = parseMarkdownDocument(markdown, 'AI 回复')
      const created = await options.createDocument(imported.title, {
        parentId: options.currentDocumentId.value,
        content: imported.content,
        plainText: imported.plainText,
      })
      if (!created) return

      options.expandDocument(options.currentDocumentId.value)
      await options.loadDocument(created.id, created)
      options.notify.success('AI 回复已写入子页面')
    })
  }

  function selectHistory(historyId: string): void {
    if (options.conversation.selectHistory(historyId)) options.showChat.value = true
  }

  return {
    openChat,
    retryMessage,
    insertMessage,
    openSourceDocument,
    openEditorDocument,
    copyMessage,
    writeMessageToChildDocument,
    selectHistory,
  }
}
