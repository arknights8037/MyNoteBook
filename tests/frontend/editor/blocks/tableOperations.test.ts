import { describe, expect, it } from 'vitest'

import {
  clearTableRange,
  duplicateTableRow,
  findTableMatches,
  getTableCellLabel,
  insertTableColumn,
  insertTableRow,
  removeTableColumn,
  removeTableRow,
  sortTableRows,
} from '@/editor/blocks/tableOperations'

const rows = [
  ['项目', '优先级'],
  ['设计系统', '2'],
  ['编辑器', '10'],
]

describe('table operations', () => {
  it('inserts and removes rows relative to the selected row', () => {
    expect(insertTableRow(rows, 1)).toEqual([
      ['项目', '优先级'],
      ['设计系统', '2'],
      ['', ''],
      ['编辑器', '10'],
    ])
    expect(removeTableRow(rows, 1)).toEqual([
      ['项目', '优先级'],
      ['编辑器', '10'],
    ])
  })

  it('inserts, removes and duplicates dimensions without mutating input', () => {
    expect(insertTableColumn(rows, 0)[0]).toEqual(['项目', '', '优先级'])
    expect(removeTableColumn(rows, 0)[0]).toEqual(['优先级'])
    expect(duplicateTableRow(rows, 1)[2]).toEqual(['设计系统', '2'])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual(['项目', '优先级'])
  })

  it('clears a rectangular selection', () => {
    expect(
      clearTableRange(rows, {
        start: { row: 1, column: 0 },
        end: { row: 2, column: 1 },
      }),
    ).toEqual([
      ['项目', '优先级'],
      ['', ''],
      ['', ''],
    ])
  })

  it('sorts records naturally while keeping the field row in place', () => {
    expect(sortTableRows(rows, 1, 'ascending')).toEqual([
      ['项目', '优先级'],
      ['设计系统', '2'],
      ['编辑器', '10'],
    ])
    expect(sortTableRows(rows, 1, 'descending')).toEqual([
      ['项目', '优先级'],
      ['编辑器', '10'],
      ['设计系统', '2'],
    ])
  })

  it('finds matches case-insensitively and exposes spreadsheet cell labels', () => {
    expect(findTableMatches(rows, '编辑')).toEqual([{ row: 2, column: 0 }])
    expect(getTableCellLabel({ row: 2, column: 27 })).toBe('AB3')
  })
})
