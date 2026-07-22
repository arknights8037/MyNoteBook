import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

import type { DocumentId, DocumentSummary } from '@/models/documents/document'
import { displayDocumentTitle } from '@/models/documents/documentPresentation'

interface DocumentSearchOptions {
  documents: Ref<DocumentSummary[]>
  getGroupArticleCount: (groupId: DocumentId) => number
  searchDocuments?: (query: string, limit: number) => Promise<DocumentSummary[]>
  onOpen?: () => void
}

const SEARCH_DEBOUNCE_MS = 120
const SEARCH_RESULT_LIMIT = 50

export function useDocumentSearch(options: DocumentSearchOptions) {
  const showSearchModal = ref(false)
  const searchQuery = ref('')
  const remoteResults = ref<DocumentSummary[]>([])
  const isSearching = ref(false)
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchGeneration = 0

  const searchResults = computed(() => {
    const query = searchQuery.value.trim().toLocaleLowerCase()
    if (!query) return []

    const localResults = options.documents.value.filter((document) => {
      const searchableText = [
        displayDocumentTitle(document),
        document.plainText,
        document.tags.join(' '),
        document.sourceUrl,
        document.author,
        document.description,
      ]
        .join('\n')
        .toLocaleLowerCase()
      return searchableText.includes(query)
    })

    const seen = new Set<DocumentId>()
    return [...remoteResults.value, ...localResults].filter((document) => {
      if (seen.has(document.id)) return false
      seen.add(document.id)
      return true
    })
  })

  watch(
    searchQuery,
    (query) => {
      const normalizedQuery = query.trim()
      const generation = ++searchGeneration
      remoteResults.value = []
      isSearching.value = false
      if (searchTimer) clearTimeout(searchTimer)
      if (!normalizedQuery || !options.searchDocuments) return

      isSearching.value = true
      searchTimer = setTimeout(async () => {
        searchTimer = null
        try {
          const results = await options.searchDocuments!(normalizedQuery, SEARCH_RESULT_LIMIT)
          if (generation === searchGeneration) remoteResults.value = results
        } catch {
          // Metadata-only local results remain usable if native full-text search is unavailable.
        } finally {
          if (generation === searchGeneration) isSearching.value = false
        }
      }, SEARCH_DEBOUNCE_MS)
    },
    { flush: 'sync' },
  )

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (searchTimer) clearTimeout(searchTimer)
    })
  }

  function openSearch(): void {
    options.onOpen?.()
    showSearchModal.value = true
  }

  function closeSearch(): void {
    showSearchModal.value = false
    searchQuery.value = ''
  }

  function getSearchSnippet(document: DocumentSummary): string {
    if (document.documentKind === 'group') {
      return `${options.getGroupArticleCount(document.id)} 个页面`
    }

    const normalized = document.plainText.replace(/\s+/g, ' ').trim()
    return normalized || '暂无正文'
  }

  return {
    showSearchModal,
    searchQuery,
    searchResults,
    isSearching,
    openSearch,
    closeSearch,
    getSearchSnippet,
  }
}
