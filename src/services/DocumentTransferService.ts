import {
  exportDocumentToHtml,
  exportDocumentToMarkdown,
  metadataFromDocument,
  type ExportableDocumentMetadata,
} from '@/editor/documentExport'
import { parseNotebookJsonDocument } from '@/editor/jsonImport'
import { parseMarkdownDocument } from '@/editor/markdownImport'
import type { DocumentRecord, DocumentSummary, TiptapDocumentJson } from '@/models/document'
import {
  createExportFileName,
  inferDocumentImportFormat,
  type DocumentExportFormat,
  type DocumentImportFormat,
} from '@/models/documentTransfer'

export interface DocumentImportSource {
  fileName: string
  text: string
  format?: DocumentImportFormat | null
}

export interface ImportedDocument {
  format: DocumentImportFormat
  title: string
  content: TiptapDocumentJson
  plainText: string
}

export interface DocumentExportSource {
  document: DocumentRecord | DocumentSummary
  content: TiptapDocumentJson
  title?: string
}

export interface PreparedDocumentExport {
  title: string
  markdown: string
  html: string
}

export interface SaveDocumentExportResult {
  path: string
  format: DocumentExportFormat
}

export interface DocumentTransferFilePort {
  chooseSavePath(options: {
    title: string
    defaultPath: string
    extension: 'md' | 'html'
  }): Promise<string | null>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface DocumentTransferConverters {
  parseJson(text: string, fallbackTitle: string): Omit<ImportedDocument, 'format'>
  parseMarkdown(text: string, fallbackTitle: string): Omit<ImportedDocument, 'format'>
  toMarkdown(content: TiptapDocumentJson, metadata: ExportableDocumentMetadata): Promise<string>
  toHtml(content: TiptapDocumentJson, metadata: ExportableDocumentMetadata): Promise<string>
}

const DEFAULT_CONVERTERS: DocumentTransferConverters = {
  parseJson: parseNotebookJsonDocument,
  parseMarkdown: parseMarkdownDocument,
  toMarkdown: exportDocumentToMarkdown,
  toHtml: exportDocumentToHtml,
}

export class UnsupportedDocumentImportError extends Error {
  constructor(fileName: string) {
    super(`不支持的导入文件：${fileName}。请选择 .json、.md 或 .markdown 文件。`)
    this.name = 'UnsupportedDocumentImportError'
  }
}

export class DocumentTransferService {
  constructor(
    private readonly filePort?: DocumentTransferFilePort,
    private readonly converters: DocumentTransferConverters = DEFAULT_CONVERTERS,
  ) {}

  parseImport(source: DocumentImportSource): ImportedDocument {
    const format = source.format ?? inferDocumentImportFormat(source.fileName)
    if (!format) throw new UnsupportedDocumentImportError(source.fileName)

    const parsed =
      format === 'json'
        ? this.converters.parseJson(source.text, source.fileName)
        : this.converters.parseMarkdown(source.text, source.fileName)

    return { format, ...parsed }
  }

  async prepareExport(source: DocumentExportSource): Promise<PreparedDocumentExport> {
    const title = source.title?.trim() || source.document.title
    const metadata = metadataFromDocument({ ...source.document, title })
    const [markdown, html] = await Promise.all([
      this.converters.toMarkdown(source.content, metadata),
      this.converters.toHtml(source.content, metadata),
    ])

    return { title, markdown, html }
  }

  async saveExport(
    prepared: PreparedDocumentExport,
    format: DocumentExportFormat,
    fallbackTitle = '未命名文档',
  ): Promise<SaveDocumentExportResult | null> {
    if (!this.filePort) {
      throw new Error('保存导出文件需要 DocumentTransferFilePort。')
    }

    const extension = format === 'markdown' ? 'md' : 'html'
    const path = await this.filePort.chooseSavePath({
      title: format === 'markdown' ? '导出 Markdown' : '导出 HTML',
      defaultPath: createExportFileName(prepared.title, extension, fallbackTitle),
      extension,
    })
    if (!path) return null

    await this.filePort.writeTextFile(
      path,
      format === 'markdown' ? prepared.markdown : prepared.html,
    )
    return { path, format }
  }
}
