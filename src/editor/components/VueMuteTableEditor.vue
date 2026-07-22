<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'

import { createDefaultTableRows, normalizeTableRows } from '@/editor/blocks/structuredBlocks'

const props = defineProps<{
  rows?: string[][] | null
}>()

const emit = defineEmits<{
  update: [rows: string[][]]
}>()

const tableRows = computed(() => normalizeRows(props.rows))
const activeCell = ref<{ row: number; column: number } | null>(null)

function updateRows(nextRows: string[][]): void {
  emit('update', normalizeTableRows(nextRows))
}

function updateCell(rowIndex: number, columnIndex: number, value: string): void {
  const nextRows = tableRows.value.map((row) => [...row])
  nextRows[rowIndex][columnIndex] = value
  updateRows(nextRows)
}

function addRow(afterIndex = tableRows.value.length - 1): void {
  const columnCount = tableRows.value[0]?.length ?? 2
  const nextRows = tableRows.value.map((row) => [...row])
  nextRows.splice(
    afterIndex + 1,
    0,
    Array.from({ length: columnCount }, () => ''),
  )
  updateRows(nextRows)
  void focusCell(afterIndex + 1, 0)
}

function addColumn(afterIndex = (tableRows.value[0]?.length ?? 1) - 1): void {
  const nextRows = tableRows.value.map((row) => {
    const nextRow = [...row]
    nextRow.splice(afterIndex + 1, 0, '')
    return nextRow
  })
  updateRows(nextRows)
  void focusCell(0, afterIndex + 1)
}

function removeRow(rowIndex = tableRows.value.length - 1): void {
  if (tableRows.value.length <= 1) return
  const nextRows = tableRows.value.filter((_, index) => index !== rowIndex)
  updateRows(nextRows)
  void focusCell(Math.max(rowIndex - 1, 0), 0)
}

function removeColumn(columnIndex = (tableRows.value[0]?.length ?? 1) - 1): void {
  if ((tableRows.value[0]?.length ?? 0) <= 1) return
  updateRows(tableRows.value.map((row) => row.filter((_, index) => index !== columnIndex)))
  void focusCell(0, Math.max(columnIndex - 1, 0))
}

function handleCellKeydown(
  event: InstanceType<typeof globalThis.KeyboardEvent>,
  rowIndex: number,
  columnIndex: number,
): void {
  if (event.key === 'Tab') {
    event.preventDefault()
    const delta = event.shiftKey ? -1 : 1
    focusLinearCell(rowIndex, columnIndex, delta)
    return
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (rowIndex === tableRows.value.length - 1) {
      addRow(rowIndex)
    } else {
      void focusCell(rowIndex + 1, columnIndex)
    }
    return
  }

  if (event.key === 'ArrowUp') {
    void focusCell(Math.max(rowIndex - 1, 0), columnIndex)
    return
  }

  if (event.key === 'ArrowDown') {
    void focusCell(Math.min(rowIndex + 1, tableRows.value.length - 1), columnIndex)
    return
  }
}

function handleCellPaste(
  event: InstanceType<typeof globalThis.ClipboardEvent>,
  rowIndex: number,
  columnIndex: number,
): void {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text.includes('\t') && !text.includes('\n')) return

  event.preventDefault()
  const pastedRows = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((row) => row.length > 0)
    .map((row) => row.split('\t'))

  if (pastedRows.length === 0) return

  const width = Math.max(tableRows.value[0]?.length ?? 1, columnIndex + pastedRows[0].length)
  const nextRows = tableRows.value.map((row) => padRow(row, width))

  for (let rowOffset = 0; rowOffset < pastedRows.length; rowOffset += 1) {
    const targetRowIndex = rowIndex + rowOffset
    if (!nextRows[targetRowIndex]) {
      nextRows[targetRowIndex] = Array.from({ length: width }, () => '')
    }

    pastedRows[rowOffset].forEach((cell, cellOffset) => {
      nextRows[targetRowIndex][columnIndex + cellOffset] = cell
    })
  }

  updateRows(nextRows)
}

function focusLinearCell(rowIndex: number, columnIndex: number, delta: 1 | -1): void {
  const columnCount = tableRows.value[0]?.length ?? 1
  const cellCount = tableRows.value.length * columnCount
  let nextIndex = rowIndex * columnCount + columnIndex + delta

  if (nextIndex >= cellCount) {
    addRow(tableRows.value.length - 1)
    nextIndex = cellCount
  }

  if (nextIndex < 0) nextIndex = 0
  void focusCell(Math.floor(nextIndex / columnCount), nextIndex % columnCount)
}

async function focusCell(rowIndex: number, columnIndex: number): Promise<void> {
  activeCell.value = {
    row: rowIndex,
    column: columnIndex,
  }
  await nextTick()
  const selector = `[data-vue-mute-cell="${rowIndex}:${columnIndex}"]`
  const element = globalThis.document.querySelector(selector)
  if (element instanceof globalThis.HTMLTextAreaElement) {
    element.focus()
    element.select()
  }
}

function padRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? '')
}

function normalizeRows(value: unknown): string[][] {
  const normalizedRows = normalizeTableRows(value)
  return normalizedRows.length > 0 ? normalizedRows : createDefaultTableRows()
}
</script>

<template>
  <div class="vue-mute-table">
    <div class="vue-mute-table__toolbar">
      <span>VUE-MUTE-TABLE</span>
      <button type="button" @click="addRow()"><Plus :size="14" /> 行</button>
      <button type="button" @click="addColumn()"><Plus :size="14" /> 列</button>
      <button type="button" :disabled="tableRows.length <= 1" @click="removeRow()">
        <Trash2 :size="14" /> 行
      </button>
      <button type="button" :disabled="(tableRows[0]?.length ?? 0) <= 1" @click="removeColumn()">
        <Trash2 :size="14" /> 列
      </button>
    </div>

    <div class="vue-mute-table__viewport">
      <table>
        <tbody>
          <tr v-for="(row, rowIndex) in tableRows" :key="rowIndex">
            <td
              v-for="(cell, columnIndex) in row"
              :key="columnIndex"
              :class="{
                'vue-mute-table__cell--active':
                  activeCell?.row === rowIndex && activeCell?.column === columnIndex,
              }"
            >
              <textarea
                :data-vue-mute-cell="`${rowIndex}:${columnIndex}`"
                :value="cell"
                rows="1"
                spellcheck="false"
                :aria-label="`表格 ${rowIndex + 1} 行 ${columnIndex + 1} 列`"
                @focus="activeCell = { row: rowIndex, column: columnIndex }"
                @input="
                  updateCell(rowIndex, columnIndex, ($event.target as HTMLTextAreaElement).value)
                "
                @keydown="handleCellKeydown($event, rowIndex, columnIndex)"
                @paste="handleCellPaste($event, rowIndex, columnIndex)"
              ></textarea>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
