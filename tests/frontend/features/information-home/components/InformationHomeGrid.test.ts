import { mount } from '@vue/test-utils'
import { GridItem, GridLayout } from 'grid-layout-plus'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import InformationHomeGrid from '@/features/information-home/components/InformationHomeGrid.vue'
import type { InformationHomeWidget } from '@/models/home/informationHome'

describe('InformationHomeGrid', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses the grid library resize handle only while editing', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
      return this.classList.contains('information-home-grid') ? 1300 : 1600
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
      return this.classList.contains('information-home-grid') ? 1300 : 1600
    })
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
    await nextTick()

    expect(wrapper.find('.vgl-item__resizer').exists()).toBe(true)
    expect(wrapper.find('.information-home-grid__resize-handle').exists()).toBe(false)
    expect(wrapper.get('.vgl-item').classes()).toContain('vgl-item--resizable')
    expect(wrapper.getComponent(GridLayout).props('verticalCompact')).toBe(false)
    expect(wrapper.getComponent(GridLayout).props('preventCollision')).toBe(false)
    expect(wrapper.getComponent(GridLayout).props('restoreOnDrag')).toBe(false)
    expect(wrapper.getComponent(GridItem).props('minH')).toBe(2)
    expect(wrapper.getComponent(GridItem).props('minW')).toBe(2)
    expect(wrapper.getComponent(GridItem).props('resizeOption')).toEqual({})
    expect(wrapper.getComponent(GridLayout).props('rowHeight')).toBe(97.5)
    expect(wrapper.get('.information-home-grid').attributes('style')).toContain(
      '--information-home-grid-track-size: 107.5px',
    )

    await wrapper.get('.vgl-item__resizer').trigger('pointerdown')
    wrapper.getComponent(GridItem).vm.$emit('resize', widget.id, 7, 8, 0, 0)
    globalThis.dispatchEvent(new Event('pointerup'))
    await nextTick()
    expect(wrapper.emitted('resize')?.at(-1)).toEqual([widget.id, { w: 8, h: 7 }, 'desktop'])

    const grid = wrapper.getComponent(GridLayout).vm.$.exposed
    if (!grid) throw new Error('GridLayout did not expose its interaction methods')
    grid.resizeEvent('resizeend', widget.id, 0, 0, 7, 8)
    await nextTick()
    expect(wrapper.emitted('layout')?.at(-1)).toEqual([
      {
        [widget.id]: { x: 0, y: 0, w: 8, h: 7, minW: 4, minH: 3 },
      },
      'desktop',
    ])

    grid.dragEvent('dragend', widget.id, 3, 4, 7, 8)
    await nextTick()
    expect(wrapper.emitted('layout')?.at(-1)).toEqual([
      {
        [widget.id]: { x: 3, y: 4, w: 8, h: 7, minW: 4, minH: 3 },
      },
      'desktop',
    ])

    await wrapper.setProps({ editing: false })
    await nextTick()
    expect(wrapper.find('.vgl-item__resizer').exists()).toBe(false)
  })
})
