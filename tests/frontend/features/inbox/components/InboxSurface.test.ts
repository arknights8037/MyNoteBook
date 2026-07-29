import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import InboxSurface from '@/features/inbox/components/InboxSurface.vue'

describe('InboxSurface', () => {
  it('keeps source configuration separate from daily signal handling', async () => {
    const wrapper = mount(InboxSurface, { props: { section: 'rss' } })

    expect(wrapper.get('h1').text()).toBe('RSS')
    expect(wrapper.find('.rss-inbox-panel').exists()).toBe(true)
    expect(wrapper.text()).toContain('收件箱不是插件配置页')

    await wrapper.get('.inbox-empty-state button').trigger('click')
    expect(wrapper.emitted('openConnections')).toHaveLength(1)
  })

  it('shows ingestion health separately from content sections', () => {
    const wrapper = mount(InboxSurface, { props: { section: 'failures' } })

    expect(wrapper.text()).toContain('当前没有采集异常')
    expect(wrapper.find('.inbox-overview-strip').exists()).toBe(false)
  })
})
