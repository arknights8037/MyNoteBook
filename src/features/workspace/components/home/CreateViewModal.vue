<script setup lang="ts">
import { ClipboardList, FileText, GitBranch, Presentation } from '@lucide/vue'
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
  flowchart: GitBranch,
  slides: Presentation,
  plan: ClipboardList,
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
      选择一种展示形式。所有视图共享同一套知识内容，可继续交给 Agent 处理。
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
