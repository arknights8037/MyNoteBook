import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { normalizeTableFields } from '@/editor/tableFields'
import type { TableViewPayload } from '@/models/workspaceView'
import TableViewEditor from './TableViewEditor.vue'

describe('TableViewEditor', () => {
  it('edits a standalone table without initializing VTable and syncs header fields', async () => {
    const rows = [
      ['任务', '状态'],
      ['修复表格', '进行中'],
    ]
    const payload: TableViewPayload = {
      type: 'table',
      rows,
      fields: normalizeTableFields([], rows),
    }
    const wrapper = mount(TableViewEditor, { props: { payload } })

    expect(wrapper.findComponent({ name: 'VTableBlockEditor' }).exists()).toBe(false)

    const header = wrapper.find('[data-vue-mute-cell="0:0"]')
    await header.setValue('事项')

    expect(wrapper.emitted('update')?.[0]?.[0]).toMatchObject({
      rows: [
        ['事项', '状态'],
        ['修复表格', '进行中'],
      ],
      fields: [{ name: '事项' }, { name: '状态' }],
    })
  })
})
