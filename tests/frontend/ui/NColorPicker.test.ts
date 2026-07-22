import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import NColorPicker from '@/ui/NColorPicker.vue'

describe('NColorPicker', () => {
  it('normalizes rgb colors for the native color input', () => {
    const wrapper = mount(NColorPicker, {
      props: {
        value: 'rgb(120, 69, 69)',
      },
    })

    expect(wrapper.get('input[type="color"]').attributes('value')).toBe('#784545')
  })

  it('expands short hex colors', () => {
    const wrapper = mount(NColorPicker, {
      props: {
        value: '#abc',
      },
    })

    expect(wrapper.get('input[type="color"]').attributes('value')).toBe('#aabbcc')
  })

  it('separates drag previews from the committed color', async () => {
    const wrapper = mount(NColorPicker)
    const input = wrapper.get('input[type="color"]')

    input.element.value = '#784545'
    await input.trigger('input')

    expect(wrapper.emitted('update:value')).toEqual([['#784545']])
    expect(wrapper.emitted('change:value')).toBeUndefined()

    await input.trigger('change')

    expect(wrapper.emitted('change:value')).toEqual([['#784545']])
  })
})
