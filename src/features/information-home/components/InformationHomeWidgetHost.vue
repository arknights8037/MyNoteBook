<script setup lang="ts">
import { ChevronRight, Copy, Trash2 } from '@lucide/vue'
import { computed, onErrorCaptured, ref } from 'vue'

import type {
  InformationHomeCalendarEvent,
  InformationHomeSummary,
  InformationHomeTodoItem,
  InformationHomeWidget,
} from '@/models/home/informationHome'
import DashboardWidgetFrame from '@/features/dashboard/components/DashboardWidgetFrame.vue'
import { getInformationHomeWidgetDefinition } from '../informationHomeWidgetRegistry'
import AgentSummaryHomeWidget from './AgentSummaryHomeWidget.vue'
import CalendarHomeWidget from './CalendarHomeWidget.vue'
import EmailActionsHomeWidget from './EmailActionsHomeWidget.vue'
import RssNewsHomeWidget from './RssNewsHomeWidget.vue'
import TodoListHomeWidget from './TodoListHomeWidget.vue'
import LocalEnvironmentPanel from '@/features/integrations/environment/components/LocalEnvironmentPanel.vue'

type BrowserMouseEvent = InstanceType<typeof globalThis.MouseEvent>
type PersistenceState = 'idle' | 'saving' | 'saved' | 'error'

const props = withDefaults(
  defineProps<{
    widget: InformationHomeWidget
    editing: boolean
    summaries: InformationHomeSummary[]
    rssSummary?: InformationHomeSummary | null
    generatingSummary: boolean
    autoSummaryEnabled: boolean
    summaryIntervalMinutes: number
    settingsState?: PersistenceState
    summarySettingsState?: PersistenceState
  }>(),
  { rssSummary: null, settingsState: 'idle', summarySettingsState: 'idle' },
)
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
const environmentWidget = ref<InstanceType<typeof LocalEnvironmentPanel> | null>(null)
const refreshing = ref(false)
const renderError = ref('')
const metrics = ref<Array<{ value: number; label: string }>>([])
const showSizeMenu = ref(false)
const sizeMenuPosition = ref({ x: 0, y: 0 })
const activeSubmenu = ref<'size' | null>(null)
const widthOptions = Array.from({ length: 11 }, (_, index) => index + 2)
const heightOptions = Array.from({ length: 9 }, (_, index) => index + 2)
const sizePresets = [
  { w: 4, h: 3 },
  { w: 6, h: 4 },
  { w: 8, h: 5 },
  { w: 12, h: 5 },
]
const definition = computed(() => getInformationHomeWidgetDefinition(props.widget.widgetType))
const title = computed(() => props.widget.settings.title || definition.value.title)
const emptyTodoItems: InformationHomeTodoItem[] = []
const emptyCalendarEvents: InformationHomeCalendarEvent[] = []
const todoItems = computed(() => props.widget.settings.todos ?? emptyTodoItems)
const calendarEvents = computed(() => props.widget.settings.events ?? emptyCalendarEvents)
const frameSystemState = computed<PersistenceState>(() => {
  if (props.widget.widgetType === 'agent-summary') {
    if (props.generatingSummary) return 'saving'
    return props.summarySettingsState
  }
  return props.settingsState
})

onErrorCaptured((error) => {
  renderError.value = error instanceof Error ? error.message : String(error)
  return false
})

function refresh(): void {
  renderError.value = ''
  if (props.widget.widgetType === 'email-actions') void emailWidget.value?.refresh()
  if (props.widget.widgetType === 'rss-news') void rssWidget.value?.refresh()
  if (props.widget.widgetType === 'local-environment') void environmentWidget.value?.refresh()
}

function selectSize(size: { w: number; h: number }, close = true): void {
  emit('resize', size)
  if (close) showSizeMenu.value = false
}

function openWidgetContextMenu(event: BrowserMouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const width = 444
  const height = 300
  sizeMenuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, globalThis.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, globalThis.innerHeight - height - 8)),
  }
  activeSubmenu.value = null
  showSizeMenu.value = true
}

function updateMetrics(next: Array<{ value: number; label: string }>): void {
  if (
    metrics.value.length === next.length &&
    metrics.value.every(
      (item, index) => item.value === next[index]?.value && item.label === next[index]?.label,
    )
  )
    return
  metrics.value = next
}

function selectWidth(width: number): void {
  selectSize({ w: width, h: props.widget.layout.desktop.h }, false)
}

function selectHeight(height: number): void {
  selectSize({ w: props.widget.layout.desktop.w, h: height }, false)
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
    :system-state="frameSystemState"
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
      :summaries="summaries"
      @open="emit('openEmail', $event)"
      @refreshing="refreshing = $event"
      @metrics="updateMetrics"
    />
    <RssNewsHomeWidget
      v-else-if="widget.widgetType === 'rss-news'"
      ref="rssWidget"
      :limit="widget.query.limit"
      :summary="rssSummary ?? null"
      @open="emit('openRss', $event)"
      @refreshing="refreshing = $event"
      @metrics="updateMetrics"
    />
    <AgentSummaryHomeWidget
      v-else-if="widget.widgetType === 'agent-summary'"
      :summaries="summaries"
      :generating="generatingSummary"
      :auto-enabled="autoSummaryEnabled"
      :interval-minutes="summaryIntervalMinutes"
      :settings-state="summarySettingsState"
      @generate="emit('generateSummary')"
      @toggle-auto="emit('toggleAutoSummary')"
      @change-interval="emit('changeSummaryInterval')"
      @open-email="emit('openEmail', $event)"
    />
    <TodoListHomeWidget
      v-else-if="widget.widgetType === 'todo-list'"
      :items="todoItems"
      :editing="editing"
      :persistence-state="settingsState"
      @metrics="updateMetrics"
      @update="emit('updateSettings', { ...widget.settings, todos: $event })"
    />
    <CalendarHomeWidget
      v-else-if="widget.widgetType === 'calendar'"
      :events="calendarEvents"
      :editing="editing"
      :persistence-state="settingsState"
      @metrics="updateMetrics"
      @update="emit('updateSettings', { ...widget.settings, events: $event })"
    />
    <LocalEnvironmentPanel v-else ref="environmentWidget" compact />
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
        <div class="home-widget-size-menu__submenu-host" @mouseenter="activeSubmenu = 'size'">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            :aria-expanded="activeSubmenu === 'size'"
            @click="activeSubmenu = activeSubmenu === 'size' ? null : 'size'"
          >
            <span>卡片尺寸</span
            ><small>{{ widget.layout.desktop.w }} × {{ widget.layout.desktop.h }}</small
            ><ChevronRight :size="13" />
          </button>
          <div
            v-if="activeSubmenu === 'size'"
            class="home-widget-size-menu__submenu"
            role="menu"
            aria-label="卡片尺寸"
          >
            <section>
              <header><strong>宽度</strong></header>
              <div>
                <button
                  v-for="width in widthOptions"
                  :key="`width-${width}`"
                  type="button"
                  :class="{ 'is-active': widget.layout.desktop.w === width }"
                  @click="selectWidth(width)"
                >
                  {{ width }}
                </button>
              </div>
            </section>
            <section>
              <header><strong>高度</strong></header>
              <div>
                <button
                  v-for="height in heightOptions"
                  :key="`height-${height}`"
                  type="button"
                  :class="{ 'is-active': widget.layout.desktop.h === height }"
                  @click="selectHeight(height)"
                >
                  {{ height }}
                </button>
              </div>
            </section>
            <section>
              <header><strong>常用尺寸</strong></header>
              <div class="is-presets">
                <button
                  v-for="size in sizePresets"
                  :key="`${size.w}x${size.h}`"
                  type="button"
                  class="home-widget-size-menu__preset"
                  :class="{
                    'is-active':
                      widget.layout.desktop.w === size.w && widget.layout.desktop.h === size.h,
                  }"
                  @click="selectSize(size)"
                >
                  {{ size.w }} × {{ size.h }}
                </button>
              </div>
            </section>
          </div>
        </div>
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
