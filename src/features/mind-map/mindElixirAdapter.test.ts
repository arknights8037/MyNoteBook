import { describe, expect, it } from 'vitest'

import { createEmptyMindMapContent } from '@/models/mindMap'
import { fromMindElixirData, toMindElixirData } from './mindElixirAdapter'

describe('mindElixirAdapter', () => {
  it('round trips stable node ids, ordering, metadata and cross links', () => {
    const content = createEmptyMindMapContent('root', '主题')
    content.direction = 'both'
    content.nodes.child = {
      id: 'child',
      parentId: 'root',
      order: 0,
      text: '子节点',
      note: '说明',
      collapsed: true,
      branchDirection: 'left',
      sourceRefs: [
        { type: 'knowledge_object', knowledgeObjectId: 'knowledge-1', revision: 2 },
      ],
      metadata: { confidence: 0.9 },
      style: { color: '#333333' },
    }
    content.links.push({
      id: 'link-1',
      fromNodeId: 'root',
      toNodeId: 'child',
      relationType: 'supports',
      label: '支持',
    })

    const roundTrip = fromMindElixirData(toMindElixirData(content))

    expect(roundTrip).toEqual(content)
  })

  it('inherits a root branch direction for every descendant', () => {
    const content = createEmptyMindMapContent('root', '主题')
    content.nodes.left = {
      id: 'left', parentId: 'root', order: 0, text: '左侧', note: '', collapsed: false,
      branchDirection: 'left', sourceRefs: [], metadata: {}, style: {},
    }
    content.nodes.descendant = {
      id: 'descendant', parentId: 'left', order: 0, text: '后代', note: '', collapsed: false,
      sourceRefs: [], metadata: {}, style: {},
    }

    const restored = fromMindElixirData(toMindElixirData(content))

    expect(restored.nodes.descendant.branchDirection).toBe('left')
  })
})
