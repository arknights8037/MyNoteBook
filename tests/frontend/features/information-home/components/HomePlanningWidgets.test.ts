import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import CalendarHomeWidget from '@/features/information-home/components/CalendarHomeWidget.vue'
import TodoListHomeWidget from '@/features/information-home/components/TodoListHomeWidget.vue'

describe('information home planning widgets', () => {
  it('creates and completes local todo items', async () => {
    const wrapper = mount(TodoListHomeWidget, { props: { items: [], editing: false } })

    await wrapper.get('input[aria-label="待办内容"]').setValue('整理今日信息')
    await wrapper.get('form').trigger('submit')

    const created = wrapper.emitted('update')?.[0]?.[0]
    expect(created).toMatchObject([{ title: '整理今日信息', completed: false }])

    await wrapper.setProps({ items: created })
    await wrapper.get('button[aria-label="完成待办"]').trigger('click')
    expect(wrapper.emitted('update')?.[1]?.[0]?.[0]).toMatchObject({ completed: true })
  })

  it('adds a dated event to the local calendar', async () => {
    const wrapper = mount(CalendarHomeWidget, { props: { events: [], editing: false } })

    await wrapper.get('input[aria-label="日程日期"]').setValue('2026-07-31')
    await wrapper.get('input[aria-label="日程内容"]').setValue('项目复盘')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('update')?.[0]?.[0]).toMatchObject([
      { title: '项目复盘', date: '2026-07-31' },
    ])
  })
})
