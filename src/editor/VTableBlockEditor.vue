<script setup lang="ts">
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronLeft,
  ChevronRight,
  Columns3,
  CopyPlus,
  Eraser,
  MoreHorizontal,
  Plus,
  Rows3,
  Search,
  Settings2,
  Table2,
  Tags,
  Trash2,
  X,
} from '@lucide/vue'
import type { ListTableAll as VTableListTable } from '@visactor/vtable/es/ListTable-all'
import type {
  CellRange,
  ColumnDefine,
  ListTableConstructorOptions,
} from '@visactor/vtable/es/ts-types'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { normalizeTableRows } from './structuredBlocks'
import {
  TABLE_ENUM_PRESETS,
  TABLE_FIELD_TYPES,
  applyTableFieldsToRows,
  getTableFieldTypeLabel,
  insertTableField,
  normalizeTableFields,
  removeTableField,
  syncTableFieldsFromHeader,
  type TableField,
} from './tableFields'
import {
  clearTableRange,
  duplicateTableRow,
  findTableMatches,
  getTableCellLabel,
  getTableColumnCount,
  getTableColumnLabel,
  insertTableColumn,
  insertTableRow,
  removeTableColumn,
  removeTableRow,
  sortTableRows,
  type TableCellAddress,
  type TableCellRange,
  type TableSortDirection,
} from './tableOperations'
import VueMuteTableEditor from './VueMuteTableEditor.vue'
import { useVTableFieldMenu } from './composables/useVTableFieldMenu'
import {
  getVTableFieldName,
  normalizeVTableRows,
  rowsToVTableRecords,
  vtableRecordsToRows,
} from './vtableDataAdapter'
import { getVTableThemeColors } from './vtableTheme'

type VTableModule = typeof import('@visactor/vtable/es/ListTable-all')
type VTableEditorsModule = typeof import('@visactor/vtable-editors')
type VTableRegisterModule = typeof import('@visactor/vtable/es/register')

const VTABLE_TEXT_EDITOR = 'my-notebook-text-editor'
const VTABLE_DATE_EDITOR = 'my-notebook-date-editor'
const VTABLE_LONG_TEXT_EDITOR = 'my-notebook-long-text-editor'
const VTABLE_CHECKBOX_EDITOR = 'my-notebook-checkbox-editor'
const BASE_ROW_HEIGHT = 40
const BASE_COLUMN_WIDTH = 164

const props = defineProps<{
  fields?: TableField[] | null
  rows?: string[][] | null
}>()

const emit = defineEmits<{
  update: [rows: string[][]]
  updateFields: [fields: TableField[]]
}>()

const container = ref<InstanceType<typeof globalThis.HTMLElement> | null>(null)
const blockRoot = ref<InstanceType<typeof globalThis.HTMLElement> | null>(null)
const searchInput = ref<InstanceType<typeof globalThis.HTMLInputElement> | null>(null)
const operationsMenu = ref<InstanceType<typeof globalThis.HTMLDetailsElement> | null>(null)
const fieldMenu = ref<InstanceType<typeof globalThis.HTMLElement> | null>(null)
const table = shallowRef<VTableListTable | null>(null)
const vtableModule = shallowRef<VTableModule | null>(null)
const editorsModule = shallowRef<VTableEditorsModule | null>(null)
const registerModule = shallowRef<VTableRegisterModule | null>(null)
const resizeObserver = shallowRef<InstanceType<typeof globalThis.ResizeObserver> | null>(null)
const themeObserver = shallowRef<InstanceType<typeof globalThis.MutationObserver> | null>(null)
const listenerIds = ref<number[]>([])
const initError = ref('')
const isApplyingTableUpdate = ref(false)
const isTableActive = ref(false)
const searchQuery = ref('')
const activeMatchIndex = ref(-1)
const activeCell = ref<TableCellAddress>({ row: 0, column: 0 })
const selectedRange = ref<TableCellRange>({
  start: { row: 0, column: 0 },
  end: { row: 0, column: 0 },
})
let lastTablePointerDownAt = 0
let resizeFrame = 0

const baseRows = computed(() => normalizeVTableRows(props.rows))
const tableFields = computed(() => normalizeTableFields(props.fields, baseRows.value))
const tableRows = computed(() => applyTableFieldsToRows(baseRows.value, tableFields.value))
const columnCount = computed(() => getTableColumnCount(tableRows.value))
const recordCount = computed(() => Math.max(0, tableRows.value.length - 1))
const searchMatches = computed(() => findTableMatches(tableRows.value, searchQuery.value))
const activeCellLabel = computed(() => getTableCellLabel(activeCell.value))
const activeColumnName = computed(
  () =>
    tableFields.value[activeCell.value.column]?.name ||
    tableRows.value[0]?.[activeCell.value.column]?.trim() ||
    `字段 ${getTableColumnLabel(activeCell.value.column)}`,
)
const activeFieldTypeLabel = computed(() =>
  getTableFieldTypeLabel(tableFields.value[activeCell.value.column]?.type ?? 'text'),
)
const selectedCellCount = computed(() => {
  const rowCount = Math.abs(selectedRange.value.end.row - selectedRange.value.start.row) + 1
  const colCount = Math.abs(selectedRange.value.end.column - selectedRange.value.start.column) + 1
  return rowCount * colCount
})
const selectionSummary = computed(() =>
  selectedCellCount.value === 1 ? activeCellLabel.value : `${selectedCellCount.value} 个单元格`,
)
const canvasHeight = computed(() =>
  Math.min(446, Math.max(164, tableRows.value.length * BASE_ROW_HEIGHT + 2)),
)

const {
  state: fieldMenuState,
  draft: fieldDraft,
  pendingEnumOption,
  open: openFieldMenu,
  close: closeFieldMenu,
  updateName: updateFieldDraftName,
  updateType: updateFieldDraftType,
  updateDescription: updateFieldDraftDescription,
  toggleAllowCustomOptions,
  applyPreset: applyEnumPreset,
  addEnumOption,
  removeEnumOption,
  collectColumnValues: collectColumnValuesAsEnumOptions,
  apply: applyFieldDraft,
  isEnumFieldType,
} = useVTableFieldMenu({
  container,
  fields: tableFields,
  rows: tableRows,
  activateHeaderCell: (address) => {
    activeCell.value = address
    selectedRange.value = { start: { ...address }, end: { ...address } }
    focusTableCell(address)
  },
  commitRows: (rows, focusCell, fields) => commitRows(rows, focusCell, fields),
  refreshTable: (rows, fields) => refreshTableOption(rows, fields),
})

watch(
  tableRows,
  (nextRows, previousRows) => {
    if (isApplyingTableUpdate.value) return

    if (getTableColumnCount(nextRows) !== getTableColumnCount(previousRows ?? [])) {
      refreshTableOption(nextRows)
      return
    }

    table.value?.setRecords(rowsToVTableRecords(nextRows))
    requestTableResize()
  },
  { deep: true },
)

watch(searchQuery, () => {
  activeMatchIndex.value = searchMatches.value.length > 0 ? 0 : -1
  refreshTableOption(tableRows.value)
})

watch(
  tableFields,
  (nextFields) => {
    if (isApplyingTableUpdate.value) return
    refreshTableOption(tableRows.value, nextFields)
  },
  { deep: true },
)

onMounted(() => {
  globalThis.document.addEventListener('pointerdown', handleDocumentPointerDown)
  themeObserver.value = new globalThis.MutationObserver(() => refreshTableOption(tableRows.value))
  themeObserver.value.observe(globalThis.document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  void mountVTable()
})

onBeforeUnmount(() => {
  globalThis.document.removeEventListener('pointerdown', handleDocumentPointerDown)
  themeObserver.value?.disconnect()
  themeObserver.value = null
  releaseVTable()
})

async function mountVTable(): Promise<void> {
  if (!container.value) return

  try {
    const [nextVTableModule, nextEditorsModule, nextRegisterModule] = await Promise.all([
      import('@visactor/vtable/es/ListTable-all'),
      import('@visactor/vtable-editors'),
      import('@visactor/vtable/es/register'),
    ])
    vtableModule.value = nextVTableModule
    editorsModule.value = nextEditorsModule
    registerModule.value = nextRegisterModule

    registerEditors(tableFields.value)

    const instance = new nextVTableModule.ListTableAll(
      container.value,
      createTableOptions(tableRows.value),
    )
    table.value = instance

    listenerIds.value = [
      instance.on('change_cell_value', emitRowsFromTable),
      instance.on('change_cell_values', emitRowsFromTable),
      instance.on('selected_cell', ({ col, row, ranges }) => {
        updateSelection(col, row, ranges)
      }),
      instance.on('contextmenu_cell', ({ col, row, event }) => {
        if (row === 0) {
          event?.preventDefault()
          event?.stopPropagation()
          openFieldMenu(col, event)
        }
      }),
    ]

    if ('ResizeObserver' in globalThis) {
      resizeObserver.value = new globalThis.ResizeObserver(() => requestTableResize())
      resizeObserver.value.observe(container.value)
    }

    await nextTick()
    requestTableResize()
    focusTableCell(activeCell.value)
  } catch (error) {
    initError.value = error instanceof Error ? error.message : 'VTable 初始化失败'
    globalThis.console.warn('VTable failed to initialize.', error)
    releaseVTable()
  }
}

function releaseVTable(): void {
  if (resizeFrame !== 0) {
    globalThis.cancelAnimationFrame(resizeFrame)
    resizeFrame = 0
  }
  resizeObserver.value?.disconnect()
  resizeObserver.value = null

  for (const id of listenerIds.value) {
    table.value?.off(id)
  }
  listenerIds.value = []

  table.value?.release()
  table.value = null
}

function refreshTableOption(rows: string[][], fields = tableFields.value): void {
  const instance = table.value
  if (!instance) return

  registerEditors(fields)
  void instance.updateOption(createTableOptions(rows, fields), {
    clearColWidthCache: true,
    clearRowHeightCache: false,
  })
  requestTableResize()
}

function requestTableResize(): void {
  if (resizeFrame !== 0) return
  resizeFrame = globalThis.requestAnimationFrame(() => {
    resizeFrame = 0
    table.value?.resize()
  })
}

function updateSelection(col: number, row: number, ranges: CellRange[]): void {
  activeCell.value = { row, column: col }
  const range = ranges.at(-1)
  selectedRange.value = range
    ? {
        start: { row: range.start.row, column: range.start.col },
        end: { row: range.end.row, column: range.end.col },
      }
    : { start: { ...activeCell.value }, end: { ...activeCell.value } }
}

function emitRowsFromTable(): void {
  const nextRows = vtableRecordsToRows(table.value?.records ?? [], columnCount.value)
  const nextFields = syncTableFieldsFromHeader(tableFields.value, nextRows[0] ?? [])
  isApplyingTableUpdate.value = true
  emit('updateFields', nextFields)
  emit('update', normalizeTableRows(nextRows))
  void nextTick(() => {
    isApplyingTableUpdate.value = false
  })
}

function commitRows(
  nextRows: string[][],
  nextCell = activeCell.value,
  nextFields = tableFields.value,
): void {
  const normalizedRows = applyTableFieldsToRows(normalizeTableRows(nextRows), nextFields)
  isApplyingTableUpdate.value = true
  emit('updateFields', nextFields)
  emit('update', normalizedRows)

  if (getTableColumnCount(normalizedRows) !== columnCount.value) {
    refreshTableOption(normalizedRows, nextFields)
  } else {
    table.value?.setRecords(rowsToVTableRecords(normalizedRows))
  }

  requestTableResize()
  void nextTick(() => {
    isApplyingTableUpdate.value = false
    focusTableCell({
      row: Math.min(nextCell.row, normalizedRows.length - 1),
      column: Math.min(nextCell.column, getTableColumnCount(normalizedRows) - 1),
    })
  })
}

function addRecord(afterIndex = tableRows.value.length - 1): void {
  const rowIndex = Math.max(0, Math.min(afterIndex + 1, tableRows.value.length))
  commitRows(insertTableRow(tableRows.value, afterIndex), { row: rowIndex, column: 0 })
}

function addField(afterIndex = columnCount.value - 1): void {
  const columnIndex = Math.max(0, Math.min(afterIndex + 1, columnCount.value))
  commitRows(
    insertTableColumn(tableRows.value, afterIndex),
    { row: 0, column: columnIndex },
    insertTableField(tableFields.value, afterIndex),
  )
}

function duplicateActiveRow(): void {
  const rowIndex = activeCell.value.row
  if (rowIndex === 0) return
  commitRows(duplicateTableRow(tableRows.value, rowIndex), {
    row: rowIndex + 1,
    column: activeCell.value.column,
  })
}

function removeActiveRow(): void {
  if (tableRows.value.length <= 1 || activeCell.value.row === 0) return
  const rowIndex = activeCell.value.row
  commitRows(removeTableRow(tableRows.value, rowIndex), {
    row: Math.max(0, rowIndex - 1),
    column: activeCell.value.column,
  })
}

function removeActiveColumn(): void {
  if (columnCount.value <= 1) return
  const columnIndex = activeCell.value.column
  commitRows(
    removeTableColumn(tableRows.value, columnIndex),
    {
      row: activeCell.value.row,
      column: Math.max(0, columnIndex - 1),
    },
    removeTableField(tableFields.value, columnIndex),
  )
}

function clearSelection(): void {
  commitRows(clearTableRange(tableRows.value, selectedRange.value))
}

function sortActiveColumn(direction: TableSortDirection): void {
  commitRows(sortTableRows(tableRows.value, activeCell.value.column, direction))
}

function navigateSearchMatch(delta: 1 | -1): void {
  if (searchMatches.value.length === 0) return
  const nextIndex =
    (activeMatchIndex.value + delta + searchMatches.value.length) % searchMatches.value.length
  activeMatchIndex.value = nextIndex
  focusTableCell(searchMatches.value[nextIndex])
}

function clearSearch(): void {
  searchQuery.value = ''
  searchInput.value?.focus()
}

function focusTableCell(address: TableCellAddress): void {
  activeCell.value = address
  selectedRange.value = { start: { ...address }, end: { ...address } }
  globalThis.requestAnimationFrame(() => {
    table.value?.selectCell(address.column, address.row, false, false, true)
    table.value?.scrollToCell({ col: address.column, row: address.row })
  })
}

function handleWrapperKeydown(event: InstanceType<typeof globalThis.KeyboardEvent>): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault()
    event.stopPropagation()
    searchInput.value?.focus()
    searchInput.value?.select()
  }
}

function handleDocumentPointerDown(event: InstanceType<typeof globalThis.PointerEvent>): void {
  const target = event.target
  if (target instanceof globalThis.Node && !blockRoot.value?.contains(target)) {
    isTableActive.value = false
  }
  if (target instanceof globalThis.Node && !operationsMenu.value?.contains(target)) {
    operationsMenu.value?.removeAttribute('open')
  }
  if (target instanceof globalThis.Node && !fieldMenu.value?.contains(target)) {
    closeFieldMenu()
  }
}

function activateTable(): void {
  lastTablePointerDownAt = globalThis.Date.now()
  isTableActive.value = true
  requestTableResize()
}

function handleWrapperFocusOut(event: InstanceType<typeof globalThis.FocusEvent>): void {
  if (globalThis.Date.now() - lastTablePointerDownAt < 120) {
    return
  }
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof globalThis.Node && blockRoot.value?.contains(nextTarget)) {
    return
  }
  isTableActive.value = false
}

function closeOperationsMenu(event: InstanceType<typeof globalThis.MouseEvent>): void {
  const target = event.target
  if (target instanceof globalThis.Element && target.closest('button')) {
    operationsMenu.value?.removeAttribute('open')
  }
}

function registerEditors(fields: TableField[]): void {
  if (!registerModule.value || !editorsModule.value) return

  registerModule.value.editor(VTABLE_TEXT_EDITOR, new editorsModule.value.InputEditor())
  registerModule.value.editor(VTABLE_DATE_EDITOR, new editorsModule.value.DateInputEditor())
  registerModule.value.editor(VTABLE_LONG_TEXT_EDITOR, new editorsModule.value.TextAreaEditor())
  registerModule.value.editor(
    VTABLE_CHECKBOX_EDITOR,
    new editorsModule.value.ListEditor({ values: ['是', '否'] }),
  )

  fields.forEach((field, index) => {
    if (field.type !== 'select' || field.allowCustomOptions || field.enumOptions.length === 0) {
      return
    }

    registerModule.value?.editor(
      getEnumEditorName(field, index),
      new editorsModule.value!.ListEditor({ values: field.enumOptions }),
    )
  })
}

function getEditorName(field: TableField, columnIndex: number): string {
  if (field.type === 'date') return VTABLE_DATE_EDITOR
  if (field.type === 'longText' || field.type === 'multiSelect') return VTABLE_LONG_TEXT_EDITOR
  if (field.type === 'checkbox') return VTABLE_CHECKBOX_EDITOR
  if (field.type === 'select' && !field.allowCustomOptions && field.enumOptions.length > 0) {
    return getEnumEditorName(field, columnIndex)
  }
  return VTABLE_TEXT_EDITOR
}

function getEnumEditorName(field: TableField, columnIndex: number): string {
  return `my-notebook-enum-${field.id || columnIndex}`
}

function createTableOptions(
  rows: string[][],
  fields = tableFields.value,
): ListTableConstructorOptions {
  const colors = getVTableThemeColors()

  return {
    records: rowsToVTableRecords(rows),
    columns: createColumns(getTableColumnCount(rows), fields),
    showHeader: false,
    frozenRowCount: 1,
    eventOptions: {
      preventDefaultContextMenu: true,
    },
    defaultRowHeight: BASE_ROW_HEIGHT,
    defaultColWidth: BASE_COLUMN_WIDTH,
    widthMode: 'standard',
    heightMode: 'standard',
    autoFillWidth: false,
    overscrollBehavior: 'none',
    editCellTrigger: ['doubleclick', 'keydown'],
    keyboardOptions: {
      copySelected: true,
      pasteValueToCell: true,
      moveFocusCellOnTab: true,
      editCellOnEnter: true,
      moveFocusCellOnEnter: true,
      moveEditCellOnArrowKeys: true,
      selectAllOnCtrlA: true,
    },
    hover: {
      highlightMode: 'cell',
    },
    select: {
      highlightMode: 'cell',
      outsideClickDeselect: false,
      blankAreaClickDeselect: false,
    },
    resize: {
      columnResizeMode: 'all',
      rowResizeMode: 'none',
    },
    theme: {
      underlayBackgroundColor: colors.surface,
      bodyStyle: {
        bgColor: ({ row, col }) => {
          if (isSearchMatch(row, col)) return colors.searchMatch
          return row === 0 ? colors.headerSurface : colors.surface
        },
        borderColor: colors.gridLine,
        borderLineWidth: 1,
        color: colors.text,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 13,
        fontWeight: ({ row }) => (row === 0 ? 600 : 400),
        padding: [8, 12, 8, 12],
        textBaseline: 'middle',
        textOverflow: 'ellipsis',
      },
      frameStyle: {
        borderColor: colors.gridLine,
        borderLineWidth: 1,
      },
      selectionStyle: {
        cellBorderColor: colors.selectionBorder,
        cellBorderLineWidth: 1,
        cellBgColor: colors.selectionBackground,
      },
      scrollStyle: {
        width: 7,
        visible: 'focus',
        hoverOn: true,
        barToSide: true,
        scrollRailColor: 'transparent',
        scrollSliderColor: colors.scrollbar,
        scrollSliderCornerRadius: 999,
      },
    },
  }
}

function isSearchMatch(row: number, column: number): boolean {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN')
  return (
    query.length > 0 && tableRows.value[row]?.[column]?.toLocaleLowerCase('zh-CN').includes(query)
  )
}

function createColumns(count: number, fields = tableFields.value): ColumnDefine[] {
  return Array.from({ length: count }, (_, index) => ({
    field: getVTableFieldName(index),
    title: fields[index]?.name ?? getTableColumnLabel(index),
    width: BASE_COLUMN_WIDTH,
    minWidth: 104,
    editor: getEditorName(fields[index] ?? tableFields.value[index], index),
  }))
}
</script>

<template>
  <div
    ref="blockRoot"
    class="vtable-block"
    @focusout="handleWrapperFocusOut"
    @keydown.capture="handleWrapperKeydown"
    @pointerdown.capture="activateTable"
  >
    <header class="vtable-block__header">
      <div class="vtable-block__identity">
        <span class="vtable-block__mark"><Table2 :size="16" /></span>
        <div>
          <strong>多维表格</strong>
          <span>{{ recordCount }} 条记录 · {{ columnCount }} 个字段</span>
        </div>
      </div>

      <label class="vtable-block__search" :class="{ 'vtable-block__search--active': searchQuery }">
        <Search :size="14" />
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="search"
          placeholder="搜索表格"
          aria-label="搜索表格"
          @keydown.enter.prevent="navigateSearchMatch(1)"
          @keydown.shift.enter.exact.prevent="navigateSearchMatch(-1)"
        />
        <span v-if="searchQuery" class="vtable-block__match-count">
          {{ searchMatches.length ? activeMatchIndex + 1 : 0 }}/{{ searchMatches.length }}
        </span>
        <button
          v-if="searchQuery"
          type="button"
          class="vtable-block__icon-button"
          aria-label="上一个匹配项"
          :disabled="searchMatches.length === 0"
          @click="navigateSearchMatch(-1)"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          v-if="searchQuery"
          type="button"
          class="vtable-block__icon-button"
          aria-label="下一个匹配项"
          :disabled="searchMatches.length === 0"
          @click="navigateSearchMatch(1)"
        >
          <ChevronRight :size="14" />
        </button>
        <button
          v-if="searchQuery"
          type="button"
          class="vtable-block__icon-button"
          aria-label="清除搜索"
          @click="clearSearch"
        >
          <X :size="14" />
        </button>
        <kbd v-else>Ctrl F</kbd>
      </label>
    </header>

    <div class="vtable-block__toolbar">
      <div class="vtable-block__actions">
        <button type="button" class="vtable-block__primary-action" @click="addRecord()">
          <Plus :size="14" /> 新建记录
        </button>
        <button type="button" @click="addField()"><Columns3 :size="14" /> 添加字段</button>
      </div>

      <span class="vtable-block__selection" :title="`当前字段：${activeColumnName}`">
        <b>{{ selectionSummary }}</b>
        <span>{{ activeColumnName }} · {{ activeFieldTypeLabel }}</span>
      </span>

      <details ref="operationsMenu" class="vtable-block__more">
        <summary aria-label="更多表格操作"><MoreHorizontal :size="16" /> 更多</summary>
        <div class="vtable-block__menu" @click="closeOperationsMenu">
          <span class="vtable-block__menu-label">当前选择</span>
          <button type="button" @click="addRecord(activeCell.row)">
            <Rows3 :size="14" /> 在下方插入记录
          </button>
          <button type="button" @click="addField(activeCell.column)">
            <Columns3 :size="14" /> 在右侧插入字段
          </button>
          <button type="button" :disabled="activeCell.row === 0" @click="duplicateActiveRow">
            <CopyPlus :size="14" /> 复制当前行
          </button>
          <button type="button" @click="clearSelection"><Eraser :size="14" /> 清空所选内容</button>
          <span class="vtable-block__menu-separator"></span>
          <button type="button" @click="sortActiveColumn('ascending')">
            <ArrowDownAZ :size="14" /> 按“{{ activeColumnName }}”升序
          </button>
          <button type="button" @click="sortActiveColumn('descending')">
            <ArrowUpAZ :size="14" /> 按“{{ activeColumnName }}”降序
          </button>
          <span class="vtable-block__menu-separator"></span>
          <button
            type="button"
            class="vtable-block__menu-danger"
            :disabled="tableRows.length <= 1 || activeCell.row === 0"
            @click="removeActiveRow"
          >
            <Trash2 :size="14" /> 删除当前行
          </button>
          <button
            type="button"
            class="vtable-block__menu-danger"
            :disabled="columnCount <= 1"
            @click="removeActiveColumn"
          >
            <Trash2 :size="14" /> 删除当前字段
          </button>
        </div>
      </details>
    </div>

    <section
      v-if="fieldMenuState.open && fieldDraft"
      ref="fieldMenu"
      class="vtable-field-menu"
      :style="{ left: `${fieldMenuState.x}px`, top: `${fieldMenuState.y}px` }"
      @pointerdown.stop
      @contextmenu.prevent.stop
    >
      <header class="vtable-field-menu__header">
        <span><Settings2 :size="15" /> 字段设置</span>
        <button type="button" aria-label="关闭字段设置" @click="closeFieldMenu">
          <X :size="14" />
        </button>
      </header>

      <label class="vtable-field-menu__field">
        <span>字段名称</span>
        <input
          :value="fieldDraft.name"
          type="text"
          placeholder="输入字段名称"
          @input="updateFieldDraftName(($event.target as HTMLInputElement).value)"
        />
      </label>

      <label class="vtable-field-menu__field">
        <span>字段属性</span>
        <select
          :value="fieldDraft.type"
          @change="updateFieldDraftType(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="fieldType in TABLE_FIELD_TYPES"
            :key="fieldType.value"
            :value="fieldType.value"
          >
            {{ fieldType.label }}
          </option>
        </select>
      </label>

      <label class="vtable-field-menu__field">
        <span>内容说明</span>
        <textarea
          :value="fieldDraft.description"
          rows="2"
          placeholder="写一点字段用途、输入规则或内容说明"
          @input="updateFieldDraftDescription(($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </label>

      <div v-if="isEnumFieldType(fieldDraft.type)" class="vtable-field-menu__enum">
        <div class="vtable-field-menu__section-title">
          <span><Tags :size="14" /> 枚举选项</span>
          <button type="button" @click="collectColumnValuesAsEnumOptions">从当前列提取</button>
        </div>

        <div class="vtable-field-menu__presets" aria-label="枚举预设">
          <button
            v-for="preset in TABLE_ENUM_PRESETS"
            :key="preset.key"
            type="button"
            :class="{ 'vtable-field-menu__preset--active': fieldDraft.enumPreset === preset.key }"
            @click="applyEnumPreset(preset.key)"
          >
            {{ preset.label }}
          </button>
        </div>

        <div class="vtable-field-menu__chips">
          <span v-for="option in fieldDraft.enumOptions" :key="option">
            {{ option }}
            <button
              type="button"
              :aria-label="`删除枚举 ${option}`"
              @click="removeEnumOption(option)"
            >
              <X :size="12" />
            </button>
          </span>
          <em v-if="fieldDraft.enumOptions.length === 0">暂无选项，先选择预设或添加自定义项</em>
        </div>

        <form class="vtable-field-menu__add-option" @submit.prevent="addEnumOption">
          <input v-model="pendingEnumOption" type="text" placeholder="添加自定义枚举值" />
          <button type="submit">添加</button>
        </form>

        <label class="vtable-field-menu__checkbox">
          <input
            :checked="fieldDraft.allowCustomOptions"
            type="checkbox"
            @change="toggleAllowCustomOptions(($event.target as HTMLInputElement).checked)"
          />
          <span>允许单元格输入预设外的自定义值</span>
        </label>
      </div>

      <footer class="vtable-field-menu__footer">
        <button type="button" @click="closeFieldMenu">取消</button>
        <button type="button" class="vtable-field-menu__apply" @click="applyFieldDraft">
          应用字段设置
        </button>
      </footer>
    </section>

    <p v-if="initError" class="vtable-block__fallback-note">
      高性能表格未能启动，已切换到兼容编辑模式：{{ initError }}
    </p>
    <VueMuteTableEditor v-if="initError" :rows="rows" @update="commitRows" />
    <div v-else class="vtable-block__body" :style="{ height: `${canvasHeight}px` }">
      <div v-show="!isTableActive" class="vtable-block__snapshot" aria-label="多维表格预览">
        <table>
          <tbody>
            <tr v-for="(row, rowIndex) in tableRows" :key="rowIndex">
              <td v-for="(cell, columnIndex) in row" :key="columnIndex">
                {{ cell }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        ref="container"
        class="vtable-block__canvas"
        :class="{ 'vtable-block__canvas--inactive': !isTableActive }"
      ></div>
    </div>

    <footer class="vtable-block__footer">
      <span><i></i> 已同步到当前文档</span>
      <span>双击编辑 · Tab 切换 · 支持粘贴 Excel 数据</span>
    </footer>
  </div>
</template>
