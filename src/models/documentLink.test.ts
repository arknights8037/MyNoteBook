import { describe, expect, it } from 'vitest'

import {
  createInternalDocumentHref,
  isLocalDocumentHref,
  parseInternalDocumentHref,
  resolveLocalDocumentHref,
} from './documentLink'

describe('internal document links', () => {
  it('round-trips document and block ids', () => {
    const href = createInternalDocumentHref('doc/制度', 'block-1')
    expect(parseInternalDocumentHref(href)).toEqual({ documentId: 'doc/制度', blockId: 'block-1' })
  })

  it('keeps legacy document-only links readable', () => {
    expect(parseInternalDocumentHref('#document=doc-1')).toEqual({ documentId: 'doc-1' })
  })

  it('resolves imported relative, Windows and file URLs by source file', () => {
    const documents = [{ id: 'doc-2', title: '不同的 H1', sourceUrl: 'target note.md' }]

    expect(resolveLocalDocumentHref('./target%20note.md', documents)).toEqual({ documentId: 'doc-2' })
    expect(resolveLocalDocumentHref('C:\\notes\\target note.md', documents)).toEqual({ documentId: 'doc-2' })
    expect(resolveLocalDocumentHref('file:///C:/notes/target%20note.md#section', documents)).toEqual({ documentId: 'doc-2' })
  })

  it('falls back to document titles for legacy imports without source metadata', () => {
    expect(resolveLocalDocumentHref('../notes/项目计划.md', [
      { id: 'doc-3', title: '项目计划' },
    ])).toEqual({ documentId: 'doc-3' })
  })

  it('does not treat web URLs or in-page anchors as local documents', () => {
    expect(isLocalDocumentHref('https://example.com/notes.md')).toBe(false)
    expect(isLocalDocumentHref('obsidian://open?vault=notes')).toBe(false)
    expect(isLocalDocumentHref('#section')).toBe(false)
  })
})
