<script setup lang="ts">
import { NButton, NInput, NModal } from '@/ui'

export interface WorkspaceItemMetadata {
  id: string
  kind: 'mindmap' | 'workspace-view'
  title: string
  typeLabel: string
  parentLabel: string
  detailLabel: string
  createdAt: number
  updatedAt: number
  pinned: boolean
}

defineProps<{
  target: WorkspaceItemMetadata | null
  mode: 'rename' | 'properties' | null
  busy: boolean
  formatDateTime: (timestamp: number) => string
}>()

const show = defineModel<boolean>('show', { required: true })
const title = defineModel<string>('title', { required: true })
const emit = defineEmits<{ save: [] }>()
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="mode === 'rename' ? `重命名${target?.typeLabel ?? '视图'}` : `${target?.title ?? '视图'} · 属性`"
    class="document-properties-modal"
    :bordered="false"
  >
    <NInput
      v-if="mode === 'rename'"
      v-model:value="title"
      autofocus
      maxlength="160"
      show-count
      placeholder="输入新名称"
      aria-label="新名称"
      @keydown.enter.prevent="emit('save')"
      @keydown.esc.prevent="show = false"
    />
    <dl v-else-if="target" class="document-properties">
      <div class="document-properties__row"><dt>类型</dt><dd>{{ target.typeLabel }}</dd></div>
      <div class="document-properties__row"><dt>上级位置</dt><dd>{{ target.parentLabel }}</dd></div>
      <div class="document-properties__row"><dt>内容</dt><dd>{{ target.detailLabel }}</dd></div>
      <div v-if="target.kind === 'workspace-view'" class="document-properties__row"><dt>置顶</dt><dd>{{ target.pinned ? '已置顶' : '未置顶' }}</dd></div>
      <div class="document-properties__row"><dt>创建时间</dt><dd>{{ formatDateTime(target.createdAt) }}</dd></div>
      <div class="document-properties__row"><dt>最后修改</dt><dd>{{ formatDateTime(target.updatedAt) }}</dd></div>
    </dl>
    <template #footer>
      <NButton @click="show = false">{{ mode === 'rename' ? '取消' : '关闭' }}</NButton>
      <NButton v-if="mode === 'rename'" type="primary" :loading="busy" @click="emit('save')">保存</NButton>
    </template>
  </NModal>
</template>
