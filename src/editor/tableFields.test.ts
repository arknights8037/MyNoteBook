import { describe, expect, it } from 'vitest'

import {
  TABLE_ENUM_PRESETS,
  applyTableFieldsToRows,
  insertTableField,
  normalizeEnumOptions,
  normalizeTableFields,
  removeTableField,
  syncTableFieldsFromHeader,
} from './tableFields'

describe('table fields', () => {
  const rows = [
    ['任务', '状态'],
    ['完善表格', '进行中'],
  ]

  it('creates field metadata from legacy table headers', () => {
    expect(normalizeTableFields(undefined, rows)).toMatchObject([
      { name: '任务', type: 'text' },
      { name: '状态', type: 'text' },
    ])
  })

  it('applies field names back to the header row', () => {
    const fields = normalizeTableFields([{ name: '标题' }, { name: '阶段' }], rows)
    expect(applyTableFieldsToRows(rows, fields)[0]).toEqual(['标题', '阶段'])
  })

  it('syncs direct header edits into field metadata', () => {
    const fields = normalizeTableFields(undefined, rows)
    expect(syncTableFieldsFromHeader(fields, ['事项', '进度'])[0].name).toBe('事项')
  })

  it('deduplicates enum options and keeps presets available', () => {
    expect(normalizeEnumOptions(['P0', 'P0', '', ' P1 '])).toEqual(['P0', 'P1'])
    expect(TABLE_ENUM_PRESETS.some((preset) => preset.key === 'status')).toBe(true)
  })

  it('inserts and removes field metadata with table dimensions', () => {
    const fields = normalizeTableFields(undefined, rows)
    const inserted = insertTableField(fields, 0)
    expect(inserted).toHaveLength(3)
    expect(inserted[1].name).toBe('字段 B')
    expect(removeTableField(inserted, 1)).toHaveLength(2)
  })
})
