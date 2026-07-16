<script setup lang="ts">
import type { TableViewPayload } from '@/models/workspaceView'
import VueMuteTableEditor from '@/editor/VueMuteTableEditor.vue'
import { applyTableFieldsToRows, normalizeTableFields, syncTableFieldsFromHeader } from '@/editor/tableFields'
import { normalizeTableRows } from '@/editor/structuredBlocks'

const props = defineProps<{ payload: TableViewPayload }>()
const emit = defineEmits<{ update: [payload: TableViewPayload] }>()

function updateRows(value: string[][]): void {
  const rows = normalizeTableRows(value)
  const fields = syncTableFieldsFromHeader(
    normalizeTableFields(props.payload.fields, rows),
    rows[0] ?? [],
  )

  emit('update', {
    ...props.payload,
    rows: applyTableFieldsToRows(rows, fields),
    fields,
  })
}
</script>

<template>
  <div class="table-view-editor">
    <VueMuteTableEditor
      :rows="applyTableFieldsToRows(payload.rows, payload.fields)"
      @update="updateRows"
    />
  </div>
</template>
