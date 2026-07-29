<script setup lang="ts">
import { Copy, Trash2 } from '@lucide/vue'
import { computed, onErrorCaptured, ref } from 'vue'

import type { InformationHomeSummary, InformationHomeWidget } from '@/models/home/informationHome'
import DashboardWidgetFrame from '@/features/dashboard/components/DashboardWidgetFrame.vue'
import { getInformationHomeWidgetDefinition } from '../informationHomeWidgetRegistry'
import AgentSummaryHomeWidget from './AgentSummaryHomeWidget.vue'
import CalendarHomeWidget from './CalendarHomeWidget.vue'
import EmailActionsHomeWidget from './EmailActionsHomeWidget.vue'
import RssNewsHomeWidget from './RssNewsHomeWidget.vue'
import TodoListHomeWidget from './TodoListHomeWidget.vue'

type BrowserMouseEvent = InstanceType<typeof globalThis.MouseEvent>

const props = defineProps<{
  widget: InformationHomeWidget
  editing: boolean
  summary: InformationHomeSummary | null
  generatingSummary: boolean
  autoSummaryEnabled: boolean
  summaryIntervalMinutes: number
}>()
const emit = defineEmits<{
  copy: []
  remove: []
  openEmail: [id?: string]
  openRss: [id?: string]
  generateSummary: []
  toggleAutoSummary: []
  changeSummaryInterval: []
  resize: [size: { w: number; h: number }]
  updateSettings: [settings: InformationHomeWidget['settings']]
}>()

const emailWidget = ref<InstanceType<typeof EmailActionsHomeWidget> | null>(null)
const rssWidget = ref<InstanceType<typeof RssNewsHomeWidget> | null>(null)
const refreshing = ref(false)
const renderError = ref('')
const metrics = ref<Array<{ value: number; label: string }>>([])
const showSizeMenu = ref(false)
const sizeMenuPosition = ref({ x: 0, y: 0 })
const sizePresets = [
  { w: 4, h: 3 },
  { w: 6, h: 4 },
  { w: 8, h: 5 },
  { w: 12, h: 5 },
]
const definition = computed(() => getInformationHomeWidgetDefinition(props.widget.widgetType))
const title = computed(() => props.widget.settings.title || definition.value.title)

onErrorCaptured((error) => {
  renderError.value = error instanceof Error ? error.message : String(error)
  return false
})

function refresh(): void {
  renderError.value = ''
  if (props.widget.widgetType === 'email-actions') void emailWidget.value?.refresh()
  if (props.widget.widgetType === 'rss-news') void rssWidget.value?.refresh()
}

function selectSize(size: { w: number; h: number }): void {
  emit('resize', size)
  showSizeMenu.value = false
}

function openWidgetContextMenu(event: BrowserMouseEvent): void {
  if (!props.editing) return
  event.preventDefault()
  event.stopPropagation()
  const width = 176
  const height = 252
  sizeMenuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, globalThis.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, globalThis.innerHeight - height - 8)),
  }
  showSizeMenu.value = true
}

function copyWidget(): void {
  emit('copy')
  showSizeMenu.value = false
}

function removeWidget(): void {
  emit('remove')
  showSizeMenu.value = false
}
</script>

<template>
  <DashboardWidgetFrame
    :title="title"
    :source="definition.source"
    :editing="editing"
    :refreshing="refreshing"
    :refreshable="widget.widgetType !== 'agent-summary'"
    @copy="emit('copy')"
    @remove="emit('remove')"
    @refresh="refresh"
    @contextmenu="openWidgetContextMenu"
  >
    <template v-if="metrics.length" #summary>
      <span v-for="item in metrics" :key="item.label">
        <strong>{{ item.value }}</strong
        ><small>{{ item.label }}</small>
      </span>
    </template>
    <div v-if="renderError" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>模块渲染失败</strong><span>{{ renderError }}</span
      ><button type="button" @click="refresh">重试</button>
    </div>
    <EmailActionsHomeWidget
      v-else-if="widget.widgetType === 'email-actions'"
      ref="emailWidget"
      :limit="widget.query.limit"
      @open="emit('openEmail', $event)"
      @refreshing="refreshing = $event"
      @metrics="metrics = $event"
    />
    <RssNewsHomeWidget
      v-else-if="widget.widgetType === 'rss-news'"
      ref="rssWidget"
      :limit="widget.query.limit"
      @open="emit('openRss', $event)"
      @refreshing="refreshing = $event"
      @metrics="metrics = $event"
    />
    <AgentSummaryHomeWidget
      v-else-if="widget.widgetType === 'agent-summary'"
      :summary="summary"
      :generating="generatingSummary"
      :auto-enabled="autoSummaryEnabled"
      :interval-minutes="summaryIntervalMinutes"
      @generate="emit('generateSummary')"
      @toggle-auto="emit('toggleAutoSummary')"
      @change-interval="emit('changeSummaryInterval')"
    />
    <TodoListHomeWidget
      v-else-if="widget.widgetType === 'todo-list'"
      :items="widget.settings.todos ?? []"
      :editing="editing"
      @metrics="metrics = $event"
      @update="emit('updateSettings', { ...widget.settings, todos: $event })"
    />
    <CalendarHomeWidget
      v-else
      :events="widget.settings.events ?? []"
      :editing="editing"
      @metrics="metrics = $event"
      @update="emit('updateSettings', { ...widget.settings, events: $event })"
    />
  </DashboardWidgetFrame>
  <Teleport to="body">
    <div
      v-if="showSizeMenu"
      class="home-widget-context-backdrop"
      @pointerdown.self="showSizeMenu = false"
    >
      <div
        class="home-widget-size-menu"
        role="menu"
        aria-label="卡片右键菜单"
        :style="{ left: `${sizeMenuPosition.x}px`, top: `${sizeMenuPosition.y}px` }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <p><strong>卡片尺寸</strong><small>拖动右下角可自由缩放</small></p>
        <button
          v-for="size in sizePresets"
          :key="`${size.w}x${size.h}`"
          type="button"
          role="menuitem"
          class="home-widget-size-menu__preset"
          :class="{
            'is-active': widget.layout.desktop.w === size.w && widget.layout.desktop.h === size.h,
          }"
          @click="selectSize(size)"
        >
          <span>{{ size.w }} × {{ size.h }}</span
          ><small>{{ size.w === 12 ? '全宽' : '网格' }}</small>
        </button>
        <hr />
        <button type="button" role="menuitem" @click="copyWidget">
          <Copy :size="13" /><span>复制卡片</span>
        </button>
        <button type="button" role="menuitem" class="is-danger" @click="removeWidget">
          <Trash2 :size="13" /><span>移除卡片</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
