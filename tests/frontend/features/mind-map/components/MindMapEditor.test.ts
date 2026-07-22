import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { createEmptyMindMapContent } from '@/models/workspace/mindMap'
import MindMapEditor from '@/features/mind-map/components/MindMapEditor.vue'

const mindMocks = vi.hoisted(() => ({
  addChild: vi.fn(),
  move: vi.fn(),
}))

vi.mock('mind-elixir', () => {
  class FakeMindElixir {
    static latest: FakeMindElixir | null = null
    el: HTMLElement
    currentNode: (HTMLElement & { nodeObj: { id: string } }) | null = null
    currentNodes: HTMLElement[] = []
    scaleVal = 1
    private handlers: Record<string, Array<(payload: { name: string }) => void>> = {}
    bus = {
      addListener: vi.fn((type: string, handler: (payload: { name: string }) => void) => {
        ;(this.handlers[type] ??= []).push(handler)
      }),
      removeListener: vi.fn((type: string, handler: (payload: { name: string }) => void) => {
        this.handlers[type] = (this.handlers[type] ?? []).filter((item) => item !== handler)
      }),
      fire: (type: string, payload: { name: string }) => {
        for (const handler of this.handlers[type] ?? []) handler(payload)
      },
    }
    nodes = document.createElement('div')

    constructor(options: { el: HTMLElement }) {
      this.el = options.el
      FakeMindElixir.latest = this
    }

    init(data: { nodeData: { id: string; topic: string; children?: Array<{ id: string; topic: string; direction?: 0 | 1 }> } }) {
      const append = (node: { id: string; topic: string; direction?: 0 | 1; children?: Array<{ id: string; topic: string; direction?: 0 | 1 }> }) => {
        const topic = document.createElement('me-tpc') as HTMLElement & {
          nodeObj: { id: string; topic: string; direction?: 0 | 1 }
        }
        topic.nodeObj = { id: node.id, topic: node.topic, direction: node.direction }
        topic.dataset.nodeId = node.id
        this.el.append(topic)
        node.children?.forEach(append)
      }
      append(data.nodeData)
    }

    findEle(id: string) {
      return this.el.querySelector(`[data-node-id="${id}"]`) as HTMLElement & {
        nodeObj: { id: string }
      }
    }

    selectNode(node: HTMLElement & { nodeObj: { id: string } }) {
      this.currentNode = node
      this.currentNodes = [node]
      node.classList.add('selected')
    }

    generateNewObj() {
      return { id: 'new-node', topic: '新节点' } as { id: string; topic: string; direction?: 0 | 1 }
    }

    async addChild(_target: unknown, node: { id: string; direction?: 0 | 1 }) {
      mindMocks.addChild(node)
      const created = document.createElement('me-tpc') as HTMLElement & { nodeObj: { id: string } }
      created.nodeObj = { id: node.id }
      created.dataset.nodeId = node.id
      this.el.append(created)
    }

    beginEdit = vi.fn(() => {
      const input = document.createElement('div')
      input.id = 'input-box'
      input.tabIndex = 0
      this.nodes.append(input)
      this.el.append(this.nodes)
      this.bus.fire('operation', { name: 'beginEdit' })
      input.addEventListener('blur', () => this.bus.fire('operation', { name: 'finishEdit' }))
    })
    insertSibling = vi.fn()
    removeNodes = vi.fn()
    scale = vi.fn()
    scaleFit = vi.fn()
    move(dx: number, dy: number) { mindMocks.move(dx, dy) }
    getData = vi.fn(() => ({ nodeData: { id: 'root', topic: '主题' }, direction: 2 }))
    refresh = vi.fn()
    enableEdit = vi.fn()
    disableEdit = vi.fn()
    destroy = vi.fn()
  }

  return { default: FakeMindElixir }
})

describe('MindMapEditor', () => {
  it('selects the root and creates explicitly directed root branches', async () => {
    const wrapper = mount(MindMapEditor, {
      props: { content: createEmptyMindMapContent('root', '主题') },
      global: {
        stubs: {
          ContextMenuRoot: { template: '<div><slot /></div>' },
          ContextMenuTrigger: { template: '<div><slot /></div>' },
          ContextMenuPortal: { template: '<div><slot /></div>' },
          ContextMenuContent: { template: '<div class="document-card-menu"><slot /></div>' },
          ContextMenuItem: { template: '<button><slot /></button>' },
          ContextMenuSeparator: { template: '<span />' },
        },
      },
    })
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))

    expect(wrapper.text()).toContain('左分支')
    expect(wrapper.text()).toContain('右分支')
    await wrapper.get('button[title="在中心主题左侧添加分支"]').trigger('click')

    const changes = wrapper.emitted('change') ?? []
    const content = changes.at(-1)?.[0] as ReturnType<typeof createEmptyMindMapContent>
    expect(Object.values(content.nodes)).toContainEqual(
      expect.objectContaining({ parentId: 'root', branchDirection: 'left' }),
    )
    wrapper.unmount()
  })

  it('pans the map with a primary-button drag on blank canvas', async () => {
    mindMocks.move.mockClear()
    const wrapper = mount(MindMapEditor, {
      props: { content: createEmptyMindMapContent('root', '主题') },
    })
    const canvas = wrapper.get('.mind-map-editor').element
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 20 }))
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 35, clientY: 55 }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 35, clientY: 55 }))

    expect(mindMocks.move).toHaveBeenCalledWith(25, 35)
  })

  it('moves keyboard focus into the node editor', async () => {
    const wrapper = mount(MindMapEditor, {
      attachTo: document.body,
      props: { content: createEmptyMindMapContent('root', '主题') },
    })
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    await wrapper.get('button[title="编辑当前节点（双击节点）"]').trigger('click')

    expect(document.activeElement?.id).toBe('input-box')
    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('inherits the current left or right branch when adding a sibling', async () => {
    const content = createEmptyMindMapContent('root', '主题')
    content.nodes.left = {
      id: 'left', parentId: 'root', order: 0, text: '左侧节点', note: '', collapsed: false,
      branchDirection: 'left', sourceRefs: [], metadata: {}, style: {},
    }
    const wrapper = mount(MindMapEditor, { props: { content } })
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    wrapper.get('[data-node-id="left"]').element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    )
    await wrapper.vm.$nextTick()
    await wrapper.get('button[title="在当前节点后添加同级节点（Enter）"]').trigger('click')

    const changes = wrapper.emitted('change') ?? []
    const updated = changes.at(-1)?.[0] as ReturnType<typeof createEmptyMindMapContent>
    const created = Object.values(updated.nodes).find((node) => node.id !== 'root' && node.id !== 'left')
    expect(created).toMatchObject({ parentId: 'root', branchDirection: 'left' })
    wrapper.unmount()
  })

  it('does not treat the edit overlay as blank canvas', async () => {
    mindMocks.move.mockClear()
    const wrapper = mount(MindMapEditor, {
      attachTo: document.body,
      props: { content: createEmptyMindMapContent('root', '主题') },
    })
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    await wrapper.get('button[title="编辑当前节点（双击节点）"]').trigger('click')

    const input = document.getElementById('input-box')!
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    input.dispatchEvent(down)
    input.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 35, clientY: 55 }))

    expect(down.defaultPrevented).toBe(false)
    expect(mindMocks.move).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })

  it('provides separate node and canvas context menus', async () => {
    const wrapper = mount(MindMapEditor, {
      props: { content: createEmptyMindMapContent('root', '主题') },
      global: {
        stubs: {
          ContextMenuRoot: { template: '<div><slot /></div>' },
          ContextMenuTrigger: { template: '<div><slot /></div>' },
          ContextMenuPortal: { template: '<div><slot /></div>' },
          ContextMenuContent: { template: '<div class="document-card-menu"><slot /></div>' },
          ContextMenuItem: { template: '<button><slot /></button>' },
          ContextMenuSeparator: { template: '<span />' },
        },
      },
    })
    const rootTopic = wrapper.get('me-tpc').element
    rootTopic.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    rootTopic.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.document-card-menu').text()).toContain('向左添加分支')

    const canvas = wrapper.get('.mind-map-editor').element
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }),
    )
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.document-card-menu').text()).toContain('导出思维导图')
    expect(wrapper.get('.document-card-menu').text()).toContain('打开开发面板')
    wrapper.unmount()
  })
})
