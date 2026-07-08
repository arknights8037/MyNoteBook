import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SettingsPage from './SettingsPage.vue'
import { DEFAULT_APP_SETTINGS } from '@/models/settings'

describe('SettingsPage', () => {
  it('renders persisted editor settings and emits navigation actions', async () => {
    const wrapper = mount(SettingsPage, {
      props: { settings: { ...DEFAULT_APP_SETTINGS } },
      attachTo: document.body,
    })

    expect(wrapper.text()).toContain('通用偏好')
    expect(wrapper.text()).toContain('数据存储')
    expect(wrapper.text()).toContain('快捷键')
    expect(wrapper.text()).toContain('复制当前块')

    await wrapper.get('button[aria-label="返回文章"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    const resetButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('恢复默认'))
    await resetButton?.trigger('click')
    expect(wrapper.emitted('reset')).toHaveLength(1)
    wrapper.unmount()
  })

  it('records a custom keyboard shortcut', async () => {
    const wrapper = mount(SettingsPage, {
      props: { settings: { ...DEFAULT_APP_SETTINGS } },
      attachTo: document.body,
    })
    const recorder = wrapper.findAll('.shortcut-recorder')[0]
    await recorder!.trigger('click')
    await recorder!.trigger('keydown', { key: 'P', ctrlKey: true, shiftKey: true })

    const changed = wrapper.emitted('change')?.at(-1)?.[0] as typeof DEFAULT_APP_SETTINGS
    expect(changed.shortcuts.search).toBe('Ctrl+Shift+P')
    wrapper.unmount()
  })
})
