import { describe, expect, it, vi } from 'vitest'

import type { DocumentRecord, TiptapDocumentJson } from '@/models/documents/document'
import {
  DocumentTransferService,
  UnsupportedDocumentImportError,
  type DocumentTransferConverters,
  type DocumentTransferFilePort,
} from '@/services/documents/DocumentTransferService'

const document: DocumentRecord = {
  id: 'doc-1',
  parentId: null,
  documentKind: 'article',
  title: '原始标题',
  tags: ['计划'],
  sourceUrl: '',
  author: '',
  description: '说明',
  contentJson: '{}',
  plainText: '正文',
  schemaVersion: 2,
  revision: 1,
  sortOrder: 0,
  isDeleted: false,
  createdAt: 1,
  updatedAt: 2,
}

const content: TiptapDocumentJson = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }],
}

describe('DocumentTransferService', () => {
  it('infers and parses Markdown imports', () => {
    const service = new DocumentTransferService()

    const imported = service.parseImport({ fileName: 'roadmap.md', text: '# 路线图\n\n正文' })

    expect(imported.format).toBe('markdown')
    expect(imported.title).toBe('路线图')
    expect(imported.plainText).toContain('正文')
  })

  it('honors an explicitly selected import format', () => {
    const service = new DocumentTransferService()
    const imported = service.parseImport({
      fileName: 'download.txt',
      format: 'json',
      text: JSON.stringify({ title: '备份', content }),
    })

    expect(imported.format).toBe('json')
    expect(imported.title).toBe('备份')
  })

  it('rejects unsupported import files with a typed error', () => {
    const service = new DocumentTransferService()

    expect(() => service.parseImport({ fileName: 'notes.txt', text: 'text' })).toThrow(
      UnsupportedDocumentImportError,
    )
  })

  it('prepares both export representations from one snapshot', async () => {
    const converters: DocumentTransferConverters = {
      parseJson: vi.fn(),
      parseMarkdown: vi.fn(),
      toMarkdown: vi.fn(async (_content, metadata) => `md:${metadata.title}`),
      toHtml: vi.fn(async (_content, metadata) => `html:${metadata.description}`),
    }
    const service = new DocumentTransferService(undefined, converters)

    const prepared = await service.prepareExport({ document, content, title: '当前标题' })

    expect(prepared).toEqual({
      title: '当前标题',
      markdown: 'md:当前标题',
      html: 'html:说明',
    })
    expect(converters.toMarkdown).toHaveBeenCalledWith(content, expect.objectContaining({
      title: '当前标题',
      tags: ['计划'],
    }))
  })

  it('writes the selected representation using the injected file port', async () => {
    const filePort: DocumentTransferFilePort = {
      chooseSavePath: vi.fn(async () => 'C:/exports/Q1.md'),
      writeTextFile: vi.fn(async () => undefined),
    }
    const service = new DocumentTransferService(filePort)
    const prepared = { title: 'Q1: 计划', markdown: '# Q1', html: '<h1>Q1</h1>' }

    await expect(service.saveExport(prepared, 'markdown')).resolves.toEqual({
      path: 'C:/exports/Q1.md',
      format: 'markdown',
    })
    expect(filePort.chooseSavePath).toHaveBeenCalledWith({
      title: '导出 Markdown',
      defaultPath: 'Q1- 计划.md',
      extension: 'md',
    })
    expect(filePort.writeTextFile).toHaveBeenCalledWith('C:/exports/Q1.md', '# Q1')
  })

  it('does not write when the save dialog is cancelled', async () => {
    const filePort: DocumentTransferFilePort = {
      chooseSavePath: vi.fn(async () => null),
      writeTextFile: vi.fn(async () => undefined),
    }
    const service = new DocumentTransferService(filePort)

    await expect(
      service.saveExport({ title: '文档', markdown: 'md', html: 'html' }, 'html'),
    ).resolves.toBeNull()
    expect(filePort.writeTextFile).not.toHaveBeenCalled()
  })
})
