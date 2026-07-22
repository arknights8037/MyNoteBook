import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { createEmptyMindMapContent } from '@/models/workspace/mindMap'
import MindMapEditor from '@/features/mind-map/components/MindMapEditor.vue'

describe('MindMapEditor with MindElixir', () => {
  it('keeps the node editor mounted and focused beyond the autosave debounce', async () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })
    const wrapper = mount(MindMapEditor, {
      attachTo: document.body,
      props: { content: createEmptyMindMapContent('root', '主题') },
    })
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))

    await wrapper.get('button[title="编辑当前节点（双击节点）"]').trigger('click')
    const input = wrapper.get('#input-box').element
    await new Promise((resolve) => globalThis.setTimeout(resolve, 650))

    expect(wrapper.find('#input-box').exists()).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(wrapper.emitted('change')).toBeUndefined()

    const editor = input as InstanceType<typeof globalThis.HTMLElement>
    editor.innerText = '更新后的主题'
    editor.blur()
    await wrapper.vm.$nextTick()
    const saved = wrapper.emitted('change')?.at(-1)?.[0] as ReturnType<
      typeof createEmptyMindMapContent
    >
    expect(saved.nodes.root.text).toBe('更新后的主题')
    wrapper.unmount()
  })

  it('closes the context menu on a primary click inside the canvas', async () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })
    const wrapper = mount(MindMapEditor, {
      attachTo: document.body,
      props: { content: createEmptyMindMapContent('root', '主题') },
    })
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))

    const topic = wrapper.get('me-tpc').element
    topic.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    topic.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }),
    )
    await wrapper.vm.$nextTick()
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20))
    expect(document.querySelector('.document-card-menu')).not.toBeNull()

    wrapper
      .get('.mind-map-editor')
      .element.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
      )
    await wrapper.vm.$nextTick()
    await vi.waitFor(() => expect(document.querySelector('.document-card-menu')).toBeNull())
    wrapper.unmount()
  })
})
