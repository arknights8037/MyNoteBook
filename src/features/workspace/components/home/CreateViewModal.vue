<script setup lang="ts">
import { FileText, GitBranch, Network, Presentation, Table2 } from '@lucide/vue'
import { computed } from 'vue'

import { NModal } from '@/ui'
import { CREATE_VIEW_OPTIONS, type CreateViewKind } from './viewTemplates'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [show: boolean]
  select: [kind: CreateViewKind]
}>()

const modalVisible = computed({
  get: () => props.show,
  set: (show: boolean) => emit('update:show', show),
})

const viewIcons = {
  document: FileText,
  uml: GitBranch,
  mindmap: Network,
  slides: Presentation,
  table: Table2,
} as const
</script>

<template>
  <NModal
    v-model:show="modalVisible"
    preset="card"
    title="新建视图"
    class="create-view-modal"
    :bordered="false"
  >
    <p class="create-view-modal__intro">
      选择一种工作形式。各视图独立编辑、独立保存，后续可由 Agent 在视图之间转换内容。
    </p>
    <div class="create-view-grid">
      <button
        v-for="option in CREATE_VIEW_OPTIONS"
        :key="option.id"
        type="button"
        class="create-view-option"
        @click="emit('select', option.id)"
      >
        <span class="create-view-option__icon">
          <component :is="viewIcons[option.id]" :size="21" />
        </span>
        <span class="create-view-option__copy">
          <strong>{{ option.title }}</strong>
          <small>{{ option.description }}</small>
        </span>
      </button>
    </div>
  </NModal>
</template>
