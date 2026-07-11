import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useDocumentSearch } from './useDocumentSearch'
import type { DocumentSummary } from '@/models/document'

describe('useDocumentSearch', () => {
  it('indexes document metadata and content case-insensitively', () => {
    const search = createSearch([
      document('one', { title: 'Architecture', tags: ['Vue'], plainText: 'Module boundaries' }),
      document('two', { author: 'Ada' }),
    ])

    search.searchQuery.value = 'vue'
    expect(search.searchResults.value.map(({ id }) => id)).toEqual(['one'])

    search.searchQuery.value = 'ADA'
    expect(search.searchResults.value.map(({ id }) => id)).toEqual(['two'])
  })

  it('owns modal lifecycle and resets the query when closed', () => {
    const onOpen = vi.fn()
    const search = createSearch([], onOpen)
    search.searchQuery.value = 'draft'

    search.openSearch()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(search.showSearchModal.value).toBe(true)

    search.closeSearch()
    expect(search.showSearchModal.value).toBe(false)
    expect(search.searchQuery.value).toBe('')
  })

  it('formats group counts and empty article snippets', () => {
    const search = createSearch([])
    expect(search.getSearchSnippet(document('group', { documentKind: 'group' }))).toBe('3 个页面')
    expect(search.getSearchSnippet(document('article'))).toBe('暂无正文')
  })
})

function createSearch(documents: DocumentSummary[], onOpen?: () => void) {
  return useDocumentSearch({
    documents: ref(documents),
    getGroupArticleCount: () => 3,
    onOpen,
  })
}

function document(id: string, overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id,
    parentId: null,
    documentKind: 'article',
    title: id,
    tags: [],
    sourceUrl: '',
    author: '',
    description: '',
    plainText: '',
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
