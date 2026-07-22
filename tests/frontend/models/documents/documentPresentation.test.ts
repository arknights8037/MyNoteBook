import { describe, expect, it } from 'vitest'

import { normalizeDocumentTitle, parseDocumentTags } from '@/models/documents/documentPresentation'

describe('document presentation', () => {
  it('normalizes empty and long titles', () => {
    expect(normalizeDocumentTitle('   ')).toBe('未命名文档')
    expect(normalizeDocumentTitle('a'.repeat(100))).toHaveLength(80)
  })

  it('deduplicates and bounds tags', () => {
    expect(parseDocumentTags('alpha，beta # alpha')).toEqual(['alpha', 'beta'])
  })
})
