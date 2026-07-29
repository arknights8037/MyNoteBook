import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import InformationHomeWidgetHost from '@/features/information-home/components/InformationHomeWidgetHost.vue'
import type { InformationHomeWidget } from '@/models/home/informationHome'

const EmailActionsHomeWidgetStub = defineComponent({
  emits: ['metrics'],
  setup() {
    return () => h('div', { 'data-test': 'email-widget' })
  },
})

describe('InformationHomeWidgetHost', () => {
  it('shows metrics in the title row and selects an explicit grid size while editing', async () => {
    const widget: InformationHomeWidget = {
      id: 'email-widget',
      widgetType: 'email-actions',
      widgetVersion: 1,
      query: { limit: 8 },
      settings: {},
      layout: { desktop: { x: 0, y: 0, w: 6, h: 4, minW: 4, minH: 3 } },
    }
    const wrapper = mount(InformationHomeWidgetHost, {
      props: {
        widget,
        editing: true,
        summary: null,
        generatingSummary: false,
        autoSummaryEnabled: false,
        summaryIntervalMinutes: 360,
      },
      global: {
        stubs: { EmailActionsHomeWidget: EmailActionsHomeWidgetStub },
      },
    })

    wrapper.getComponent(EmailActionsHomeWidgetStub).vm.$emit('metrics', [
      { value: 5, label: '待处理' },
      { value: 2, label: '账户' },
      { value: 3, label: '未读' },
    ])
    await nextTick()

    expect(wrapper.get('.dashboard-widget-frame__summary').text()).toContain('5待处理')
    expect(wrapper.get('.dashboard-widget-frame__summary').text()).toContain('3未读')

    await wrapper.get('button[aria-label="选择卡片尺寸"]').trigger('click')
    const sizeButtons = wrapper.findAll('[role="menuitem"]')
    expect(sizeButtons.map((button) => button.text())).toEqual([
      '4 × 3网格',
      '6 × 4网格',
      '8 × 5网格',
      '12 × 5全宽',
    ])
    expect(sizeButtons[1]?.classes()).toContain('is-active')

    await sizeButtons[2]?.trigger('click')
    expect(wrapper.emitted('resize')).toEqual([[{ w: 8, h: 5 }]])
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)

    await wrapper.get('.dashboard-widget-frame').trigger('contextmenu')
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
  })
})
