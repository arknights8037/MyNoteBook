import { mount } from '@vue/test-utils'
import { GridItem, GridLayout } from 'grid-layout-plus'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import InformationHomeGrid from '@/features/information-home/components/InformationHomeGrid.vue'
import type { InformationHomeWidget } from '@/models/home/informationHome'

describe('InformationHomeGrid', () => {
  it('renders the native free-resize handle only while editing', async () => {
    const widget: InformationHomeWidget = {
      id: 'todo-grid-test',
      widgetType: 'todo-list',
      widgetVersion: 1,
      query: { limit: 8 },
      settings: { todos: [] },
      layout: { desktop: { x: 0, y: 0, w: 5, h: 5, minW: 4, minH: 3 } },
    }
    const wrapper = mount(InformationHomeGrid, {
      props: {
        widgets: [widget],
        editing: true,
        summary: null,
        generatingSummary: false,
        autoSummaryEnabled: false,
        summaryIntervalMinutes: 360,
      },
    })
    await nextTick()

    expect(wrapper.find('.vgl-item__resizer').exists()).toBe(true)
    expect(wrapper.get('.vgl-item').classes()).toContain('vgl-item--resizable')
    expect(wrapper.getComponent(GridLayout).props('verticalCompact')).toBe(false)
    expect(wrapper.getComponent(GridLayout).props('preventCollision')).toBe(true)
    expect(wrapper.getComponent(GridItem).props('minH')).toBe(2)
    expect(wrapper.getComponent(GridItem).props('minW')).toBe(2)

    await wrapper.setProps({ editing: false })
    expect(wrapper.find('.vgl-item__resizer').exists()).toBe(false)
  })
})
