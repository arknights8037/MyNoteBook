import { describe, expect, it } from 'vitest'

import {
  buildAgentTargetOptions,
  buildAgentWorkspaceOptions,
} from '@/features/workspace/components/home/agentDocumentOptions'
import type { DocumentKind, DocumentSummary } from '@/models/documents/document'

describe('agentDocumentOptions', () => {
  it('projects nested documents into workspace search and target labels', () => {
    const documents = [
      document('group', null, 'group', { title: '产品', description: '路线图', tags: ['规划'] }),
      document('parent', 'group', 'article', { title: '需求' }),
      document('child', 'parent', 'article', { title: '验收' }),
      document('deleted', 'group', 'article', { title: '已删除', isDeleted: true }),
    ]

    expect(buildAgentWorkspaceOptions(documents)).toEqual([
      {
        label: '产品',
        value: 'group',
        searchText: '路线图 规划 需求 验收',
      },
    ])
    expect(buildAgentTargetOptions(documents, 'child')).toEqual([
      {
        kind: 'document',
        id: 'parent',
        title: '需求',
        subtitle: '产品 · 知识库页面',
      },
      {
        kind: 'document',
        id: 'child',
        title: '验收',
        subtitle: '产品 · 当前页面',
      },
    ])
  })
})

function document(
  id: string,
  parentId: string | null,
  documentKind: DocumentKind,
  overrides: Partial<DocumentSummary> = {},
): DocumentSummary {
  return {
    id,
    parentId,
    documentKind,
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
