import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import InboxSurface from '@/features/inbox/components/InboxSurface.vue'

describe('InboxSurface', () => {
  it('links empty sources to connection settings without a duplicate guide', async () => {
    const wrapper = mount(InboxSurface, { props: { section: 'rss' } })

    expect(wrapper.get('h1').text()).toBe('RSS')
    expect(wrapper.find('.rss-inbox-panel').exists()).toBe(true)
    expect(wrapper.find('.inbox-boundary-note').exists()).toBe(false)

    await wrapper.get('.inbox-empty-state button').trigger('click')
    expect(wrapper.emitted('openConnections')).toHaveLength(1)
  })

  it('shows ingestion health separately from content sections', () => {
    const wrapper = mount(InboxSurface, { props: { section: 'failures' } })

    expect(wrapper.text()).toContain('当前没有采集异常')
    expect(wrapper.find('.inbox-overview-strip').exists()).toBe(false)
  })

  it('routes the messages section to the live DingTalk inbox', () => {
    const wrapper = mount(InboxSurface, { props: { section: 'messages' } })

    expect(wrapper.get('h1').text()).toBe('消息')
    expect(wrapper.find('.im-inbox-panel').exists()).toBe(true)
    expect(wrapper.text()).toContain('实时通道，不是历史同步')
  })
})
