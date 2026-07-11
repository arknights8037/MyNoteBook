import { describe, expect, it } from 'vitest'

import { useDocumentCollection } from './useDocumentCollection'
import { DOCUMENT_SCHEMA_VERSION, type DocumentRecord } from '@/models/document'

function document(
  id: string,
  options: Partial<DocumentRecord> = {},
): DocumentRecord {
  return {
    id,
    parentId: null,
    documentKind: 'article',
    title: id,
    tags: [],
    sourceUrl: '',
    author: '',
    description: '',
    contentJson: '{}',
    plainText: '',
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...options,
  }
}

describe('useDocumentCollection', () => {
  it('owns active and deleted list transitions', () => {
    const collection = useDocumentCollection()
    collection.mergeDocument(document('one'))
    collection.mergeDocument(document('two', { isDeleted: true }))

    expect(collection.documents.value.map(({ id }) => id)).toEqual(['one'])
    expect(collection.deletedDocuments.value.map(({ id }) => id)).toEqual(['two'])

    collection.mergeDocument(document('two', { updatedAt: 2 }))
    collection.removeDocuments(['one'])
    expect(collection.documents.value.map(({ id }) => id)).toEqual(['two'])
    expect(collection.deletedDocuments.value).toEqual([])
  })

  it('builds group trees and exposes their article count', () => {
    const collection = useDocumentCollection()
    collection.replaceLists(
      [
        document('group', { documentKind: 'group' }),
        document('parent', { parentId: 'group' }),
        document('child', { parentId: 'parent' }),
      ],
      [],
    )

    expect(collection.articleGroups.value.map(({ id }) => id)).toEqual(['group'])
    expect(collection.getGroupArticleCount('group')).toBe(2)
    expect(collection.getGroupArticleNodes('group')[0]?.children[0]?.document.id).toBe('child')
  })

  it('reveals a nested document and expands all of its ancestors', () => {
    const collection = useDocumentCollection()
    collection.replaceLists(
      [
        document('group', { documentKind: 'group' }),
        document('parent', { parentId: 'group' }),
        document('child', { parentId: 'parent' }),
      ],
      [],
    )
    collection.toggleGroup('group')
    collection.toggleDocument('parent')

    collection.revealDocument('child')

    expect(collection.selectedGroupId.value).toBe('group')
    expect(collection.isGroupCollapsed('group')).toBe(false)
    expect(collection.collapsedDocumentIds.value.has('parent')).toBe(false)
    expect(collection.getActiveGroupId()).toBe('group')
  })
})
