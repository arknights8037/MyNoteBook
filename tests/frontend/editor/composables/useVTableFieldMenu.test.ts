import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { normalizeTableFields } from '@/editor/blocks/tableFields'
import { useVTableFieldMenu } from '@/editor/composables/useVTableFieldMenu'

describe('useVTableFieldMenu', () => {
  it('edits field metadata and commits the normalized header', () => {
    const rows = ref([
      ['任务', '状态'],
      ['拆分编辑器', '进行中'],
    ])
    const fields = computed(() => normalizeTableFields(undefined, rows.value))
    const container = globalThis.document.createElement('div')
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 600,
      height: 300,
      right: 610,
      bottom: 320,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })
    const commitRows = vi.fn()
    const refreshTable = vi.fn()
    const menu = useVTableFieldMenu({
      container: ref(container),
      fields,
      rows: computed(() => rows.value),
      activateHeaderCell: vi.fn(),
      commitRows,
      refreshTable,
    })

    menu.open(1)
    menu.updateName('阶段')
    menu.apply()

    expect(commitRows.mock.calls[0]?.[0][0]).toEqual(['任务', '阶段'])
    expect(refreshTable).toHaveBeenCalledOnce()
    expect(menu.state.value.open).toBe(false)
  })
})
