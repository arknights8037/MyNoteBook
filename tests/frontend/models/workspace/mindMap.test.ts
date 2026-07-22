import { describe, expect, it } from 'vitest'

import {
  createEmptyMindMapContent,
  mindMapToDirectionalText,
  readMindMapSubtree,
  validateMindMapContent,
  type MindMapDocument,
} from '@/models/workspace/mindMap'

function document(): MindMapDocument {
  const content = createEmptyMindMapContent('root', '产品规划')
  content.nodes.user = {
    id: 'user',
    parentId: 'root',
    order: 0,
    text: '用户需求',
    note: '优先验证',
    collapsed: false,
    sourceRefs: [
      { type: 'document_block', documentId: 'doc-1', blockId: 'block-2', revision: 3 },
    ],
    metadata: {},
    style: {},
  }
  content.nodes.search = {
    id: 'search',
    parentId: 'user',
    order: 0,
    text: '全文搜索',
    note: '',
    collapsed: false,
    sourceRefs: [],
    metadata: {},
    style: {},
  }
  return {
    id: 'map-1',
    parentId: null,
    sortOrder: 0,
    title: '产品规划',
    content,
    version: 4,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('mind map domain model', () => {
  it('validates a rooted tree and rejects cycles or unreachable nodes', () => {
    const map = document()
    expect(validateMindMapContent(map.content)).toBeNull()
    map.content.nodes.user!.parentId = 'search'
    expect(validateMindMapContent(map.content)).toContain('无法从根节点访问')
  })

  it('creates deterministic directional text with stable ids and provenance', () => {
    expect(mindMapToDirectionalText(document())).toContain(
      '-> [user] 用户需求\n    @note 优先验证\n    @source document:doc-1 block:block-2 revision:3',
    )
  })

  it('reads a bounded subtree without returning the whole map', () => {
    const result = readMindMapSubtree(document(), {
      nodeId: 'user',
      depth: 0,
      includeNotes: true,
    })
    expect(result).toMatchObject({
      version: 4,
      returnedNodes: 1,
      truncated: true,
      root: { id: 'user', note: '优先验证', children: [] },
    })
  })
})
