<script setup lang="ts">
import { NodeViewWrapper } from '@tiptap/vue-3'
import { computed } from 'vue'

import { normalizeTableRows } from '@/editor/blocks/structuredBlocks'
import { applyTableFieldsToRows, normalizeTableFields, type TableField } from '@/editor/blocks/tableFields'
import VTableBlockEditor from '@/editor/components/VTableBlockEditor.vue'

interface TableNode {
  attrs: { fields?: TableField[] | null; rows?: string[][] | null }
}

const props = defineProps<{
  node: TableNode
  selected: boolean
  updateAttributes: (attributes: Record<string, unknown>) => void
}>()

const rows = computed(() => normalizeRows(props.node.attrs.rows))
const fields = computed(() => normalizeTableFields(props.node.attrs.fields, rows.value))

function updateRows(nextRows: string[][]): void {
  const normalizedRows = normalizeTableRows(nextRows)
  props.updateAttributes({
    fields: normalizeTableFields(fields.value, normalizedRows),
    rows: normalizedRows,
  })
}

function updateFields(nextFields: TableField[]): void {
  props.updateAttributes({
    fields: normalizeTableFields(nextFields, applyTableFieldsToRows(rows.value, nextFields)),
  })
}

function normalizeRows(value: unknown): string[][] {
  return normalizeTableRows(value)
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="table-block"
    :class="{ 'table-block--selected': selected }"
    contenteditable="false"
  >
    <VTableBlockEditor :fields="fields" :rows="rows" @update="updateRows" @update-fields="updateFields" />
  </NodeViewWrapper>
</template>
