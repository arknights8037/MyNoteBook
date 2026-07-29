import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceActivityRail from '@/features/workspace/components/WorkspaceActivityRail.vue'

describe('WorkspaceActivityRail', () => {
  it('renders the active navigation item and emits semantic actions', async () => {
    const wrapper = mount(WorkspaceActivityRail, { props: { activeSurface: 'work' } })

    expect(wrapper.get('.activity-rail__item--active').text()).toContain('工作')
    const buttons = wrapper.findAll('.activity-rail__nav button')
    await buttons.find((button) => button.text() === '工作')?.trigger('click')
    await buttons.find((button) => button.text().includes('收件箱'))?.trigger('click')
    await buttons.find((button) => button.text() === '知识')?.trigger('click')
    await buttons.find((button) => button.text().includes('连接与扩展'))?.trigger('click')
    await buttons.find((button) => button.text().includes('活动与审计'))?.trigger('click')

    expect(wrapper.emitted('work')).toHaveLength(1)
    expect(wrapper.emitted('inbox')).toHaveLength(1)
    expect(wrapper.emitted('knowledge')).toHaveLength(1)
    expect(wrapper.emitted('extensions')).toHaveLength(1)
    expect(wrapper.emitted('activity')).toHaveLength(1)
    expect(wrapper.findAll('.activity-rail__nav')[0]!.text()).toContain('首页')
    expect(wrapper.findAll('.activity-rail__nav')[0]!.text()).toContain('连接与扩展')
    expect(wrapper.findAll('.activity-rail__nav')[1]!.text()).not.toContain('连接与扩展')
    expect(wrapper.text()).toContain('工作区')
    expect(wrapper.text()).toContain('管理')
  })

  it('uses the brand as the information dashboard entry', async () => {
    const wrapper = mount(WorkspaceActivityRail, { props: { activeSurface: 'home' } })

    await wrapper.get('.activity-rail__brand').trigger('click')

    expect(wrapper.emitted('home')).toHaveLength(1)
    expect(wrapper.get('.activity-rail__brand').attributes('aria-label')).toBe('打开信息面板')
  })
})
