import { describe, expect, it } from 'vitest'

import {
  buildSidebarDocumentForest,
  collectArticleDescendants,
  countSidebarDocumentNodes,
} from './documentTree'
import type { DocumentKind, DocumentSummary } from '@/models/document'

describe('documentTree', () => {
  it('builds nested page trees inside groups and at the root', () => {
    const documents = [
      createSummary('group', null, 'group'),
      createSummary('parent', 'group'),
      createSummary('child', 'parent'),
      createSummary('grandchild', 'child'),
      createSummary('root', null),
    ]

    const forest = buildSidebarDocumentForest(documents)
    const groupNodes = forest.nodesByGroup.get('group') ?? []

    expect(groupNodes[0]?.document.id).toBe('parent')
    expect(groupNodes[0]?.children[0]?.document.id).toBe('child')
    expect(groupNodes[0]?.children[0]?.children[0]?.document.id).toBe('grandchild')
    expect(countSidebarDocumentNodes(groupNodes)).toBe(3)
    expect(forest.rootNodes.map((node) => node.document.id)).toEqual(['root'])
  })

  it('keeps orphaned and cyclic pages visible at the root', () => {
    const forest = buildSidebarDocumentForest([
      createSummary('orphan', 'missing'),
      createSummary('cycle-a', 'cycle-b'),
      createSummary('cycle-b', 'cycle-a'),
    ])

    expect(forest.rootNodes.map((node) => node.document.id)).toEqual([
      'orphan',
      'cycle-a',
      'cycle-b',
    ])
  })

  it('collects every descendant without looping', () => {
    const documents = [
      createSummary('parent', null),
      createSummary('child-a', 'parent'),
      createSummary('child-b', 'parent'),
      createSummary('grandchild', 'child-a'),
    ]

    expect(collectArticleDescendants(documents, 'parent').map((document) => document.id)).toEqual([
      'child-a',
      'grandchild',
      'child-b',
    ])
  })
})

function createSummary(
  id: string,
  parentId: string | null,
  documentKind: DocumentKind = 'article',
): DocumentSummary {
  return {
    id,
    parentId,
    documentKind,
    title: id,
    plainText: '',
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
