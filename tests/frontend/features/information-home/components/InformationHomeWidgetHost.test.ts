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

    await wrapper.get('.dashboard-widget-frame').trigger('contextmenu', {
      clientX: 120,
      clientY: 160,
    })
    const menu = document.body.querySelector<HTMLElement>('[aria-label="卡片右键菜单"]')
    expect(menu).not.toBeNull()
    expect(menu?.style.left).toBe('120px')
    expect(menu?.style.top).toBe('160px')
    const sizeMenuButton = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>(':scope > div > button') ?? [],
    ).find((button) => button.textContent?.includes('卡片尺寸'))
    sizeMenuButton?.click()
    await nextTick()
    expect(document.body.querySelector('[aria-label="卡片尺寸"]')).not.toBeNull()
    const sizeButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.home-widget-size-menu__preset'),
    )
    expect(sizeButtons.map((button) => button.textContent)).toEqual([
      '4 × 3',
      '6 × 4',
      '8 × 5',
      '12 × 5',
    ])
    expect(sizeButtons[1]?.classList.contains('is-active')).toBe(true)

    const heightSection = Array.from(
      document.body.querySelectorAll<HTMLElement>('.home-widget-size-menu__submenu section'),
    ).find((section) => section.querySelector('header')?.textContent?.includes('高度'))
    const heightSeven = Array.from(
      heightSection?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.trim() === '7')
    heightSeven?.click()
    await nextTick()
    expect(wrapper.emitted('resize')?.[0]).toEqual([{ w: 6, h: 7 }])

    sizeButtons[2]?.click()
    await nextTick()
    expect(wrapper.emitted('resize')?.[1]).toEqual([{ w: 8, h: 5 }])
    expect(document.body.querySelector('[aria-label="卡片右键菜单"]')).toBeNull()

    await wrapper.get('.dashboard-widget-frame').trigger('contextmenu', {
      clientX: 180,
      clientY: 220,
    })
    expect(document.body.querySelector('[aria-label="卡片右键菜单"]')).not.toBeNull()
    wrapper.unmount()
  })
})
