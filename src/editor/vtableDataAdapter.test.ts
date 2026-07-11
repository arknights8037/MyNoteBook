import { describe, expect, it } from 'vitest'

import {
  getVTableFieldName,
  normalizeVTableRows,
  rowsToVTableRecords,
  vtableRecordsToRows,
} from './vtableDataAdapter'

describe('vtable data adapter', () => {
  it('round-trips rectangular rows through records', () => {
    const rows = [
      ['任务', '状态'],
      ['拆分编辑器', '进行中'],
    ]
    expect(vtableRecordsToRows(rowsToVTableRecords(rows), 2)).toEqual(rows)
  })

  it('normalizes missing rows to the editor default table', () => {
    const rows = normalizeVTableRows(null)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]?.length).toBeGreaterThan(0)
  })

  it('uses stable column field names', () => {
    expect(getVTableFieldName(3)).toBe('c3')
  })
})
