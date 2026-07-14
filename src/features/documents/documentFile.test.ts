import { describe, expect, it } from 'vitest'

import { createExportFileName, inferDocumentImportFormat } from './documentFile'

describe('documentFile', () => {
  it('recognizes supported import extensions case-insensitively', () => {
    expect(inferDocumentImportFormat('notes.JSON')).toBe('json')
    expect(inferDocumentImportFormat('notes.Markdown')).toBe('markdown')
    expect(inferDocumentImportFormat('notes.txt')).toBeNull()
  })

  it('creates safe export names with a fallback', () => {
    expect(createExportFileName('  Q1: plan / draft  ', 'md')).toBe('Q1- plan - draft.md')
    expect(createExportFileName('   ', 'html')).toBe('未命名文档.html')
  })
})
