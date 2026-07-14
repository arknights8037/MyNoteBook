<script setup lang="ts">
import { NButton, NModal } from '@/ui'

defineProps<{ html: string }>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  export: [format: 'markdown' | 'html']
}>()
</script>

<template>
  <NModal v-model:show="show" preset="card" title="只读分享预览" class="share-modal" :bordered="false">
    <div class="share-actions">
      <NButton secondary @click="emit('export', 'markdown')">导出 Markdown</NButton>
      <NButton type="primary" @click="emit('export', 'html')">导出 HTML</NButton>
    </div>
    <iframe class="share-preview" title="只读分享预览" sandbox="" :srcdoc="html"></iframe>
  </NModal>
</template>
