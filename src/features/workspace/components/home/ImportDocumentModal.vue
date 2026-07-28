<script setup lang="ts">
import { Files, FolderOpen } from '@lucide/vue'

import { NButton, NInput, NModal } from '@/ui'

const show = defineModel<boolean>('show', { required: true })
const groupTitle = defineModel<string>('groupTitle', { default: '导入的文档' })

defineProps<{
  pendingCount: number
  skippedCount: number
  busy: boolean
}>()

const emit = defineEmits<{
  select: [mode: 'files' | 'folder']
  confirm: [createGroup: boolean]
  cancel: []
}>()
</script>

<template>
  <NModal v-model:show="show" preset="card" title="导入文档" class="import-modal" :bordered="false">
    <div v-if="pendingCount === 0" class="import-options" aria-label="导入来源">
      <button type="button" class="import-option-card" @click="emit('select', 'files')">
        <span class="import-option-card__icon"><Files :size="22" /></span>
        <span class="import-option-card__content">
          <span class="import-option-card__title">选择多个文件</span>
          <span class="import-option-card__description">可同时选择 Markdown 和 JSON，自动识别格式</span>
        </span>
      </button>
      <button type="button" class="import-option-card" @click="emit('select', 'folder')">
        <span class="import-option-card__icon"><FolderOpen :size="22" /></span>
        <span class="import-option-card__content">
          <span class="import-option-card__title">选择文件夹</span>
          <span class="import-option-card__description">扫描文件夹并只导入 .md、.markdown 和 .json</span>
        </span>
      </button>
    </div>
    <div v-else class="import-batch-confirm">
      <p class="import-batch-confirm__summary">
        已选择 <strong>{{ pendingCount }}</strong> 个可解析文件
        <span v-if="skippedCount">，将跳过 {{ skippedCount }} 个不支持的文件</span>。
      </p>
      <label class="import-batch-confirm__field">
        <span>新分组名称</span>
        <NInput v-model:value="groupTitle" :disabled="busy" maxlength="80" />
      </label>
      <p class="import-batch-confirm__hint">
        你可以创建新分组集中管理，也可以直接导入当前选中的分组。
      </p>
    </div>
    <template v-if="pendingCount > 0" #footer>
      <NButton :disabled="busy" @click="emit('cancel')">取消</NButton>
      <NButton :disabled="busy" @click="emit('confirm', false)">导入当前分组</NButton>
      <NButton type="primary" :loading="busy" @click="emit('confirm', true)">
        创建分组并导入
      </NButton>
    </template>
  </NModal>
</template>
