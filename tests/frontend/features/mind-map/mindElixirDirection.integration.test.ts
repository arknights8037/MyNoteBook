import MindElixir from 'mind-elixir'
import { describe, expect, it } from 'vitest'

import { createEmptyMindMapContent } from '@/models/workspace/mindMap'
import { toMindElixirData } from '@/features/mind-map/mindElixirAdapter'

describe('MindElixir branch direction integration', () => {
  it('renders persisted root branches on their requested sides after refresh', () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })
    const element = document.createElement('div')
    document.body.append(element)
    const content = createEmptyMindMapContent('root', '主题')
    content.nodes.left = {
      id: 'left', parentId: 'root', order: 0, text: '左侧', note: '', collapsed: false,
      branchDirection: 'left', sourceRefs: [], metadata: {}, style: {},
    }
    content.nodes.right = {
      id: 'right', parentId: 'root', order: 1, text: '右侧', note: '', collapsed: false,
      branchDirection: 'right', sourceRefs: [], metadata: {}, style: {},
    }
    const mind = new MindElixir({ el: element, direction: MindElixir.SIDE, toolBar: false })
    mind.init(toMindElixirData(createEmptyMindMapContent('root', '主题')))
    mind.refresh(toMindElixirData(content))

    expect(mind.map.querySelector('.lhs')?.textContent).toContain('左侧')
    expect(mind.map.querySelector('.rhs')?.textContent).toContain('右侧')
    mind.destroy()
    element.remove()
  })
})
