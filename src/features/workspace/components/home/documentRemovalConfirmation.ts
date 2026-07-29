import type { DocumentSummary } from '@/models/documents/document'
import { displayDocumentTitle } from '@/models/documents/documentPresentation'
import { requestDialogConfirmation, type DialogService } from '@/ui/services'

export function confirmEntireGroupRemoval(
  dialog: DialogService,
  group: DocumentSummary,
  documentCount: number,
  mindMapCount: number,
  workspaceViewCount: number,
): Promise<boolean> {
  const parts = [`${documentCount} 个文档`]
  if (mindMapCount) parts.push(`${mindMapCount} 个思维导图`)
  if (workspaceViewCount) parts.push(`${workspaceViewCount} 个结构化视图`)
  const hasPermanentItems = mindMapCount + workspaceViewCount > 0
  return requestDialogConfirmation(dialog, {
    title: '删除整个分组',
    content: `移除「${displayDocumentTitle(group)}」及其中的 ${parts.join('、')}？分组和文档可从回收站恢复${hasPermanentItems ? '，思维导图和结构化视图将永久删除' : ''}。`,
    positiveText: '删除整个分组',
    negativeText: '取消',
  })
}

export function confirmDocumentRemoval(
  dialog: DialogService,
  document: DocumentSummary,
  descendantCount: number,
  permanent: boolean,
): Promise<boolean> {
  return requestDialogConfirmation(dialog, {
    title: permanent ? '彻底删除页面' : '删除页面',
    content: permanent
      ? descendantCount > 0
        ? `彻底删除「${displayDocumentTitle(document)}」及其 ${descendantCount} 个子页面？此操作无法恢复。`
        : `彻底删除「${displayDocumentTitle(document)}」？此操作无法恢复。`
      : descendantCount > 0
        ? `删除「${displayDocumentTitle(document)}」及其 ${descendantCount} 个子页面？可在回收站恢复。`
        : `删除「${displayDocumentTitle(document)}」？可在回收站恢复。`,
    positiveText: permanent ? '彻底删除' : '删除',
    negativeText: '取消',
  })
}
