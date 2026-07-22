import { describe, expect, it } from 'vitest'

import {
  documentRecordToSummary,
  mergeDocumentRecord,
  removeDocumentSummaries,
} from '@/models/documents/documentListState'
import { DOCUMENT_SCHEMA_VERSION, type DocumentRecord } from '@/models/documents/document'

function document(id: string, updatedAt: number, isDeleted = false, sortOrder = 0): DocumentRecord {
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
    sortOrder,
    isDeleted,
    createdAt: 1,
    updatedAt,
  }
}

describe('documentListState', () => {
  it('upserts returned records without moving an existing document', () => {
    let lists = { active: [], deleted: [] }
    lists = mergeDocumentRecord(lists, { ...document('first', 10, false, 1), createdAt: 1 })
    lists = mergeDocumentRecord(lists, { ...document('second', 20, false, 2), createdAt: 2 })
    lists = mergeDocumentRecord(lists, {
      ...document('first', 30, false, 1),
      createdAt: 1,
      revision: 2,
    })

    expect(lists.active.map(({ id, revision }) => [id, revision])).toEqual([
      ['first', 2],
      ['second', 1],
    ])
  })

  it('uses creation order as a stable fallback when sort orders match', () => {
    let lists = { active: [], deleted: [] }
    lists = mergeDocumentRecord(lists, { ...document('later', 30), createdAt: 20 })
    lists = mergeDocumentRecord(lists, { ...document('earlier', 10), createdAt: 10 })
    lists = mergeDocumentRecord(lists, { ...document('earlier', 40), createdAt: 10 })

    expect(lists.active.map((item) => item.id)).toEqual(['earlier', 'later'])
  })

  it('moves soft-deleted and restored records between lists', () => {
    let lists = mergeDocumentRecord({ active: [], deleted: [] }, document('doc', 10))
    lists = mergeDocumentRecord(lists, document('doc', 20, true))
    expect(lists.active).toEqual([])
    expect(lists.deleted.map((item) => item.id)).toEqual(['doc'])

    lists = mergeDocumentRecord(lists, document('doc', 30, false))
    expect(lists.active.map((item) => item.id)).toEqual(['doc'])
    expect(lists.deleted).toEqual([])
  })

  it('removes hard-deleted records without reloading either list', () => {
    const summaries = [document('one', 10, true), document('two', 20, true)].map(
      documentRecordToSummary,
    )
    expect(removeDocumentSummaries(summaries, ['one']).map((item) => item.id)).toEqual(['two'])
  })
})
