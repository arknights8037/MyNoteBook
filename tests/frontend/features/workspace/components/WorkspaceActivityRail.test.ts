import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceActivityRail from '@/features/workspace/components/WorkspaceActivityRail.vue'

describe('WorkspaceActivityRail', () => {
  it('renders the active navigation item and emits semantic actions', async () => {
    const wrapper = mount(WorkspaceActivityRail, { props: { activeSurface: 'agent' } })

    expect(wrapper.get('.activity-rail__item--active').text()).toContain('Agent Work')
    const buttons = wrapper.findAll('.activity-rail__nav button')
    await buttons[2]!.trigger('click')
    await buttons[3]!.trigger('click')
    await buttons[4]!.trigger('click')

    expect(wrapper.emitted('knowledge')).toHaveLength(1)
    expect(wrapper.emitted('new-view')).toHaveLength(1)
    expect(wrapper.emitted('plugins')).toHaveLength(1)
  })
})
