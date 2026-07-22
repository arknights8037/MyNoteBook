import { ref, type ComputedRef, type Ref } from 'vue'

import {
  TABLE_ENUM_PRESETS,
  applyTableFieldsToRows,
  normalizeEnumOptions,
  type TableField,
  type TableFieldType,
} from '@/editor/blocks/tableFields'
import { getTableColumnLabel, type TableCellAddress } from '@/editor/blocks/tableOperations'

interface FieldMenuState {
  open: boolean
  column: number
  x: number
  y: number
}

interface UseVTableFieldMenuOptions {
  container: Readonly<Ref<HTMLElement | null>>
  fields: ComputedRef<TableField[]>
  rows: ComputedRef<string[][]>
  activateHeaderCell: (address: TableCellAddress) => void
  commitRows: (rows: string[][], focusCell: TableCellAddress, fields: TableField[]) => void
  refreshTable: (rows: string[][], fields: TableField[]) => void
}

export function useVTableFieldMenu(options: UseVTableFieldMenuOptions) {
  const state = ref<FieldMenuState>({ open: false, column: 0, x: 0, y: 0 })
  const draft = ref<TableField | null>(null)
  const pendingEnumOption = ref('')

  function open(columnIndex: number, event?: Event): void {
    const field = options.fields.value[columnIndex]
    const container = options.container.value
    if (!field || !container) return

    const containerRect = container.getBoundingClientRect()
    const menuMaxX = Math.max(10, containerRect.width - 320)
    const eventPoint =
      event && 'clientX' in event && 'clientY' in event ? (event as MouseEvent) : null
    const address = { row: 0, column: columnIndex }
    options.activateHeaderCell(address)
    draft.value = cloneField(field)
    pendingEnumOption.value = ''
    state.value = {
      open: true,
      column: columnIndex,
      x: Math.min(
        Math.max((eventPoint?.clientX ?? containerRect.left) - containerRect.left, 10),
        menuMaxX,
      ),
      y: Math.min(
        Math.max((eventPoint?.clientY ?? containerRect.top) - containerRect.top, 10),
        120,
      ),
    }
  }

  function close(): void {
    state.value.open = false
    draft.value = null
    pendingEnumOption.value = ''
  }

  function updateName(value: string): void {
    if (draft.value) draft.value = { ...draft.value, name: value }
  }

  function updateType(value: string): void {
    if (!draft.value) return
    const type = value as TableFieldType
    draft.value = {
      ...draft.value,
      type,
      enumOptions:
        draft.value.enumOptions.length > 0 || !isEnumFieldType(type)
          ? draft.value.enumOptions
          : TABLE_ENUM_PRESETS[0].options,
      enumPreset:
        draft.value.enumPreset || (isEnumFieldType(type) ? TABLE_ENUM_PRESETS[0].key : ''),
    }
  }

  function updateDescription(value: string): void {
    if (draft.value) draft.value = { ...draft.value, description: value }
  }

  function toggleAllowCustomOptions(checked: boolean): void {
    if (draft.value) draft.value = { ...draft.value, allowCustomOptions: checked }
  }

  function applyPreset(presetKey: string): void {
    if (!draft.value) return
    const preset = TABLE_ENUM_PRESETS.find((item) => item.key === presetKey)
    if (preset)
      draft.value = { ...draft.value, enumPreset: preset.key, enumOptions: preset.options }
  }

  function addEnumOption(): void {
    if (!draft.value) return
    draft.value = {
      ...draft.value,
      enumPreset: 'custom',
      enumOptions: normalizeEnumOptions([...draft.value.enumOptions, pendingEnumOption.value]),
    }
    pendingEnumOption.value = ''
  }

  function removeEnumOption(option: string): void {
    if (!draft.value) return
    draft.value = {
      ...draft.value,
      enumPreset: 'custom',
      enumOptions: draft.value.enumOptions.filter((item) => item !== option),
    }
  }

  function collectColumnValues(): void {
    if (!draft.value) return
    const columnValues = options.rows.value.slice(1).map((row) => row[state.value.column])
    draft.value = {
      ...draft.value,
      enumPreset: 'custom',
      enumOptions: normalizeEnumOptions([...draft.value.enumOptions, ...columnValues]),
    }
  }

  function apply(): void {
    if (!draft.value) return
    const column = state.value.column
    const normalizedDraft = {
      ...draft.value,
      name: draft.value.name.trim() || `字段 ${getTableColumnLabel(column)}`,
      enumOptions: normalizeEnumOptions(draft.value.enumOptions),
    }
    const nextFields = options.fields.value.map((field, index) =>
      index === column ? normalizedDraft : field,
    )
    const nextRows = applyTableFieldsToRows(options.rows.value, nextFields)
    options.commitRows(nextRows, { row: 0, column }, nextFields)
    options.refreshTable(nextRows, nextFields)
    close()
  }

  return {
    state,
    draft,
    pendingEnumOption,
    open,
    close,
    updateName,
    updateType,
    updateDescription,
    toggleAllowCustomOptions,
    applyPreset,
    addEnumOption,
    removeEnumOption,
    collectColumnValues,
    apply,
    isEnumFieldType,
  }
}

function cloneField(field: TableField): TableField {
  return { ...field, enumOptions: [...field.enumOptions] }
}

function isEnumFieldType(type: TableFieldType): boolean {
  return type === 'select' || type === 'multiSelect'
}
