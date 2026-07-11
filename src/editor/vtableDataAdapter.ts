import { createDefaultTableRows, normalizeTableRows } from './structuredBlocks'
import { getTableColumnCount } from './tableOperations'

export type VTableRecord = Record<string, string | number | null | undefined>

export function rowsToVTableRecords(rows: string[][]): VTableRecord[] {
  const width = getTableColumnCount(rows)
  return rows.map((row) =>
    Object.fromEntries(
      Array.from({ length: width }, (_, index) => [getVTableFieldName(index), row[index] ?? '']),
    ),
  )
}

export function vtableRecordsToRows(records: VTableRecord[], width: number): string[][] {
  return records.map((record) =>
    Array.from({ length: width }, (_, index) => String(record[getVTableFieldName(index)] ?? '')),
  )
}

export function getVTableFieldName(index: number): string {
  return `c${index}`
}

export function normalizeVTableRows(value: unknown): string[][] {
  const normalizedRows = normalizeTableRows(value)
  return normalizedRows.length > 0 ? normalizedRows : createDefaultTableRows()
}
