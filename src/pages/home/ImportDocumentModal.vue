<script setup lang="ts">
import { FileText, Upload } from '@lucide/vue'

import { NModal } from '@/ui'
import type { DocumentImportFormat } from '@/features/documents/documentFile'

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  select: [format: DocumentImportFormat]
}>()
</script>

<template>
  <NModal v-model:show="show" preset="card" title="导入文档" class="import-modal" :bordered="false">
    <div class="import-options" aria-label="导入格式">
      <button type="button" class="import-option-card" @click="emit('select', 'json')">
        <span class="import-option-card__icon"><FileText :size="22" /></span>
        <span class="import-option-card__content">
          <span class="import-option-card__title">JSON 格式</span>
          <span class="import-option-card__description">导入本软件导出的 JSON 文档</span>
        </span>
      </button>
      <button type="button" class="import-option-card" @click="emit('select', 'markdown')">
        <span class="import-option-card__icon"><Upload :size="22" /></span>
        <span class="import-option-card__content">
          <span class="import-option-card__title">Markdown 格式</span>
          <span class="import-option-card__description">将 .md / .markdown 转换为本软件 JSON</span>
        </span>
      </button>
    </div>
  </NModal>
</template>
