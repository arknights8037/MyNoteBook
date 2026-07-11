import { describe, expect, it } from 'vitest'

import { createInternalDocumentHref, parseInternalDocumentHref } from './documentLink'

describe('internal document links', () => {
  it('round-trips document and block ids', () => {
    const href = createInternalDocumentHref('doc/制度', 'block-1')
    expect(parseInternalDocumentHref(href)).toEqual({ documentId: 'doc/制度', blockId: 'block-1' })
  })

  it('keeps legacy document-only links readable', () => {
    expect(parseInternalDocumentHref('#document=doc-1')).toEqual({ documentId: 'doc-1' })
  })
})
