import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import type { DocumentSummary } from '@/models/documents/document'
import { useDocumentTreeActions } from '@/composables/documentWorkspace/useDocumentTreeActions'

const article: DocumentSummary = {
  id: 'article-1',
  parentId: null,
  documentKind: 'article',
  title: '文章',
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
}

describe('useDocumentTreeActions', () => {
  it('tracks drag state independently from the workspace lifecycle', () => {
    const actions = useDocumentTreeActions({
      documents: ref([article]),
      selectedGroupId: ref(null),
      currentDocumentId: ref(article.id),
      isBusy: ref(false),
      autosave: {} as UseDocumentAutosaveReturn,
      actionError: ref(null),
      getService: vi.fn(),
      runAction: vi.fn(),
      createDocument: vi.fn(),
      mergeDocument: vi.fn(),
      expandGroup: vi.fn(),
      notify: { success: vi.fn(), error: vi.fn() },
    })
    const event = new Event('dragstart') as DragEvent

    actions.handleArticleDragStart(event, article)
    expect(actions.dragDrop.draggedArticleId.value).toBe(article.id)

    actions.handleArticleDragEnd()
    expect(actions.dragDrop.draggedArticleId.value).toBeNull()
  })
})
