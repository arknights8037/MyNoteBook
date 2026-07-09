import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import MathBlockNodeView from './MathBlockNodeView.vue'

describe('MathBlockNodeView', () => {
  it('renders the existing formula preview after the node view mounts', async () => {
    const wrapper = mount(MathBlockNodeView, {
      attachTo: document.body,
      props: {
        node: { attrs: { latex: '\\sqrt{x}\\times2\\times\\frac{a}{b}', mathml: '' } },
        selected: false,
        updateAttributes: vi.fn(),
      },
      global: {
        stubs: {
          NodeViewWrapper: { template: '<div><slot /></div>' },
        },
      },
    })

    await nextTick()
    await nextTick()

    expect(wrapper.find('.math-block__rendered .katex').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens the formula type panel when the math block is selected', async () => {
    const wrapper = mount(MathBlockNodeView, {
      attachTo: document.body,
      props: {
        node: { attrs: { latex: 'E = mc^2', mathml: '' } },
        selected: true,
        updateAttributes: vi.fn(),
      },
      global: {
        stubs: {
          NodeViewWrapper: { template: '<div><slot /></div>' },
        },
      },
    })

    await nextTick()

    expect(wrapper.find('.math-block__type-list').exists()).toBe(true)
    wrapper.unmount()
  })

  it('inserts a selected Greek letter into the formula', async () => {
    const updateAttributes = vi.fn()
    const wrapper = mount(MathBlockNodeView, {
      attachTo: document.body,
      props: {
        node: { attrs: { latex: '', mathml: '' } },
        selected: false,
        updateAttributes,
      },
      global: {
        stubs: {
          NodeViewWrapper: { template: '<div><slot /></div>' },
        },
      },
    })

    await wrapper.get('.math-block__result-row').trigger('click')
    await nextTick()

    const letterTab = wrapper
      .findAll('.math-block__type-list button')
      .find((button) => button.text() === '字母')
    expect(letterTab).toBeDefined()
    await letterTab?.trigger('click')

    await wrapper.get('button[aria-label="alpha"]').trigger('click')

    expect(updateAttributes).toHaveBeenLastCalledWith({ latex: '\\alpha ', mathml: '' })
    wrapper.unmount()
  })
})
