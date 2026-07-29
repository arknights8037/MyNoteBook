import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import WorkspaceTabs from '@/features/workspace/components/WorkspaceTabs.vue'

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))

describe('WorkspaceTabs', () => {
  it('renders the independent home as a normal tab and keeps native window controls', () => {
    const wrapper = mount(WorkspaceTabs, {
      props: {
        tabs: [{ key: 'surface:home', kind: 'surface', id: 'home', title: '首页' }],
        activeKey: 'surface:home',
      },
    })

    expect(wrapper.get('.workspace-tab--active').text()).toContain('首页')
    expect(wrapper.find('.workspace-tabs__scroll').exists()).toBe(true)
    expect(wrapper.find('.workspace-tabs__new').exists()).toBe(true)
    expect(wrapper.findAll('.workspace-tabs__window-controls button')).toHaveLength(3)
    expect(wrapper.get('.workspace-tabs__window-close').attributes('aria-label')).toBe('关闭窗口')
    expect(wrapper.find('[data-tauri-drag-region]').exists()).toBe(true)
  })
})
