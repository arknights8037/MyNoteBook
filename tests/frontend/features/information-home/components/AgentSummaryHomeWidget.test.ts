import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AgentSummaryHomeWidget from '@/features/information-home/components/AgentSummaryHomeWidget.vue'
import type { InformationHomeSummary } from '@/models/home/informationHome'

describe('AgentSummaryHomeWidget', () => {
  it('renders email briefs from event results and opens the original message', async () => {
    const wrapper = mount(AgentSummaryHomeWidget, {
      props: {
        summaries: [eventSummary],
        generating: false,
        autoEnabled: true,
        intervalMinutes: 360,
      },
    })

    expect(wrapper.text()).toContain('已消费 1 次事件处理')
    expect(wrapper.text()).toContain('自动处理')
    expect(wrapper.text()).not.toContain('AUTO')
    expect(wrapper.text()).toContain('构建问题需要处理')
    expect(wrapper.text()).toContain('CI 构建失败')
    expect(wrapper.text()).toContain('Rust 检查未通过')
    expect(wrapper.text()).not.toContain('[EMAIL:account-1:INBOX:123]')

    await wrapper.get('.home-agent-summary__email-briefs > button').trigger('click')
    expect(wrapper.emitted('openEmail')).toEqual([['account-1:INBOX:123']])
  })
})

const eventSummary: InformationHomeSummary = {
  id: 'home-summary-signal-event-1',
  homeId: 'default',
  sourceCursorAt: 1,
  triggerSource: 'auto',
  status: 'completed',
  content:
    '## 处理结论\n构建问题需要处理。\n\n## 邮件简报\n- [EMAIL:account-1:INBOX:123] CI 构建失败 — Rust 检查未通过',
  provider: 'test',
  model: 'test',
  error: null,
  generatedAt: 1,
}
