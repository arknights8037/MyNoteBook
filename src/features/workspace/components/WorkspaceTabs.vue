<script setup lang="ts">
import { Bot, BrainCircuit, FileText, LayoutGrid, Plus, Settings, X } from '@lucide/vue'

export interface WorkspaceTab {
  key: string
  kind: 'document' | 'mindmap' | 'view' | 'surface'
  id: string
  title: string
}

defineProps<{
  tabs: WorkspaceTab[]
  activeKey: string
}>()

const emit = defineEmits<{
  activate: [tab: WorkspaceTab]
  close: [key: string]
  create: []
}>()

function iconFor(tab: WorkspaceTab) {
  if (tab.kind === 'document') return FileText
  if (tab.kind === 'mindmap') return BrainCircuit
  if (tab.kind === 'view') return LayoutGrid
  return tab.id === 'agent' ? Bot : Settings
}
</script>

<template>
  <header class="workspace-tabs" aria-label="打开的页面">
    <div class="workspace-tabs__scroll" role="tablist">
      <div
        v-for="tab in tabs"
        :key="tab.key"
        role="tab"
        tabindex="0"
        class="workspace-tab"
        :class="{ 'workspace-tab--active': tab.key === activeKey }"
        :aria-selected="tab.key === activeKey"
        :title="tab.title"
        @click="emit('activate', tab)"
        @keydown.enter="emit('activate', tab)"
        @keydown.space.prevent="emit('activate', tab)"
        @auxclick.middle.prevent="emit('close', tab.key)"
      >
        <component :is="iconFor(tab)" :size="14" />
        <span>{{ tab.title }}</span>
        <i v-if="tab.key === activeKey" aria-hidden="true" />
        <button
          type="button"
          class="workspace-tab__close"
          :aria-label="`关闭 ${tab.title}`"
          @click.stop="emit('close', tab.key)"
        >
          <X :size="13" />
        </button>
      </div>
    </div>
    <button type="button" class="workspace-tabs__new" aria-label="新建内容" title="新建内容" @click="emit('create')">
      <Plus :size="16" />
    </button>
  </header>
</template>
