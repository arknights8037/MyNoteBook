<script setup lang="ts">
import {
  Bot,
  BookOpenCheck,
  Blocks,
  CalendarClock,
  ClipboardList,
  FileText,
  Settings,
} from '@lucide/vue'

import type { WorkspaceSurface } from '@/models/workspace/workspaceSurface'

defineProps<{ activeSurface: WorkspaceSurface }>()

const emit = defineEmits<{
  agent: []
  documents: []
  knowledge: []
  plugins: []
  automations: []
  audit: []
  settings: []
}>()

const primaryItems = [
  { id: 'agent', label: 'Agent Work', icon: Bot, event: 'agent' },
  { id: 'document', label: '文档与视图', icon: FileText, event: 'documents' },
  { id: 'knowledge', label: '知识控制', icon: BookOpenCheck, event: 'knowledge' },
  { id: 'plugins', label: '插件技能', icon: Blocks, event: 'plugins' },
  { id: 'automations', label: '自动化任务', icon: CalendarClock, event: 'automations' },
  { id: 'audit', label: '审计记录', icon: ClipboardList, event: 'audit' },
] as const

function trigger(event: (typeof primaryItems)[number]['event']): void {
  emit(event)
}
</script>

<template>
  <aside class="activity-rail" aria-label="主功能区" tabindex="-1">
    <button class="activity-rail__brand" type="button" aria-label="打开 Agent Work" @click="emit('agent')">
      <span class="activity-rail__brand-mark"><Bot :size="19" /></span>
    </button>

    <div class="activity-rail__panel">
      <nav class="activity-rail__nav" aria-label="工作区">
        <button
          v-for="item in primaryItems"
          :key="item.id"
          type="button"
          class="activity-rail__item"
          :class="{ 'activity-rail__item--active': item.id === activeSurface }"
          :aria-current="item.id === activeSurface ? 'page' : undefined"
          @click="trigger(item.event)"
        >
          <component :is="item.icon" :size="19" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <button
        type="button"
        class="activity-rail__item activity-rail__settings"
        :class="{ 'activity-rail__item--active': activeSurface === 'settings' }"
        @click="emit('settings')"
      >
        <Settings :size="19" /><span>设置</span>
      </button>
    </div>
  </aside>
</template>
