<script setup lang="ts">
import {
  Activity,
  BookOpenCheck,
  BriefcaseBusiness,
  FileText,
  House,
  Inbox,
  PlugZap,
  Settings,
} from '@lucide/vue'

import type { WorkspaceSurface } from '@/models/workspace/workspaceSurface'
import appLogoUrl from '@/public/APP_LOGO.svg'

defineProps<{ activeSurface: WorkspaceSurface | 'home' | 'work' }>()

const emit = defineEmits<{
  home: []
  inbox: []
  work: []
  documents: []
  knowledge: []
  extensions: []
  activity: []
  settings: []
}>()

const primaryItems = [
  { id: 'home', label: '首页', icon: House, event: 'home' },
  { id: 'inbox', label: '收件箱', icon: Inbox, event: 'inbox' },
  { id: 'work', label: '工作', icon: BriefcaseBusiness, event: 'work' },
  { id: 'document', label: '文档与视图', icon: FileText, event: 'documents' },
  { id: 'knowledge', label: '知识', icon: BookOpenCheck, event: 'knowledge' },
  { id: 'plugins', label: '连接与扩展', icon: PlugZap, event: 'extensions' },
] as const

const managementItems = [
  { id: 'audit', label: '活动与审计', icon: Activity, event: 'activity' },
] as const

function trigger(
  event: (typeof primaryItems)[number]['event'] | (typeof managementItems)[number]['event'],
): void {
  emit(event)
}
</script>

<template>
  <aside class="activity-rail" aria-label="主功能区" tabindex="-1">
    <button
      class="activity-rail__brand"
      :class="{ 'activity-rail__brand--active': activeSurface === 'home' }"
      type="button"
      aria-label="打开信息面板"
      @click="emit('home')"
    >
      <span class="activity-rail__brand-mark"><img :src="appLogoUrl" alt="" /></span>
      <strong class="activity-rail__brand-name">Prism<span>Knowledge</span></strong>
    </button>

    <div class="activity-rail__panel">
      <nav class="activity-rail__nav" aria-label="主菜单">
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

      <nav class="activity-rail__nav activity-rail__nav--management" aria-label="管理">
        <span class="activity-rail__section-label">管理</span>
        <button
          v-for="item in managementItems"
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
