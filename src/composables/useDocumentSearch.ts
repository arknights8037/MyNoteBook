import { computed, ref, type Ref } from 'vue'

import type { DocumentId, DocumentSummary } from '@/models/document'
import { displayDocumentTitle } from '@/features/documents/documentPresentation'

interface DocumentSearchOptions {
  documents: Ref<DocumentSummary[]>
  getGroupArticleCount: (groupId: DocumentId) => number
  onOpen?: () => void
}

export function useDocumentSearch(options: DocumentSearchOptions) {
  const showSearchModal = ref(false)
  const searchQuery = ref('')

  const searchResults = computed(() => {
    const query = searchQuery.value.trim().toLocaleLowerCase()
    if (!query) return []

    return options.documents.value.filter((document) => {
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
  })

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
    openSearch,
    closeSearch,
    getSearchSnippet,
  }
}
