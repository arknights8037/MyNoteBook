import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import EditorTopbar from '@/features/workspace/components/home/EditorTopbar.vue'

const defaultProps = {
  title: '文档标题',
  disabled: false,
  busy: false,
  hasDocument: true,
  saveStatusClass: '',
  saveStatusText: '已保存',
  preparingShare: false,
}

describe('EditorTopbar', () => {
  it('enters title editing only after the title is clicked', async () => {
    const wrapper = mount(EditorTopbar, { props: defaultProps })

    expect(wrapper.find('input[aria-label="文档标题"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="编辑文档标题"]').trigger('click')

    const input = wrapper.get('input[aria-label="文档标题"]')
    expect(input.attributes('value')).toBe('文档标题')
    await input.setValue('新标题')
    await input.trigger('blur')

    expect(wrapper.emitted('update:title')?.at(-1)).toEqual(['新标题'])
    expect(wrapper.emitted('titleInput')).toHaveLength(1)
    expect(wrapper.emitted('commitTitle')).toHaveLength(1)
    expect(wrapper.find('input[aria-label="文档标题"]').exists()).toBe(false)
  })
})
