import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import NButton from '@/ui/NButton.vue'

describe('NButton', () => {
  it('does not render an empty content item beside an icon', () => {
    const wrapper = mount(NButton, {
      slots: {
        icon: '<svg aria-hidden="true"></svg>',
      },
    })

    expect(wrapper.find('.n-button__icon').exists()).toBe(true)
    expect(wrapper.find('.n-button__content').exists()).toBe(false)
  })

  it('keeps the content item when the button has a label', () => {
    const wrapper = mount(NButton, {
      slots: {
        icon: '<svg aria-hidden="true"></svg>',
        default: '保存',
      },
    })

    expect(wrapper.get('.n-button__content').text()).toBe('保存')
  })

  it('supports semantic submit buttons for shared form actions', () => {
    const wrapper = mount(NButton, {
      props: { nativeType: 'submit' },
      slots: { default: '提交' },
    })

    expect(wrapper.get('button').attributes('type')).toBe('submit')
  })
})
