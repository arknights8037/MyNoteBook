<script setup lang="ts">
import { GridItem, GridLayout, type Layout } from 'grid-layout-plus'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type {
  InformationHomeGridPosition,
  InformationHomeSummary,
  InformationHomeWidget,
} from '@/models/home/informationHome'
import InformationHomeWidgetHost from './InformationHomeWidgetHost.vue'

type BrowserElement = InstanceType<typeof globalThis.HTMLElement>
type BrowserResizeObserver = InstanceType<typeof globalThis.ResizeObserver>

const props = defineProps<{
  widgets: InformationHomeWidget[]
  editing: boolean
  summary: InformationHomeSummary | null
  generatingSummary: boolean
  autoSummaryEnabled: boolean
  summaryIntervalMinutes: number
}>()
const emit = defineEmits<{
  layout: [positions: Record<string, InformationHomeGridPosition>, target: 'desktop' | 'compact']
  copy: [id: string]
  remove: [id: string]
  openEmail: [id?: string]
  openRss: [id?: string]
  generateSummary: []
  toggleAutoSummary: []
  changeSummaryInterval: []
  move: [id: string, position: { x: number; y: number }, target: 'desktop' | 'compact']
  resize: [id: string, size: { w: number; h: number }, target: 'desktop' | 'compact']
  updateSettings: [id: string, settings: InformationHomeWidget['settings']]
}>()

const breakpoint = ref('lg')
const gridShell = ref<BrowserElement | null>(null)
const gridWidth = ref(0)
const gridMargin = 10
let gridResizeObserver: BrowserResizeObserver | null = null
const isCompact = computed(() => !['lg', 'md'].includes(breakpoint.value))
const columnCount = computed(() => (isCompact.value ? 6 : 12))
const rowHeight = computed(() => {
  if (!gridWidth.value) return 72
  return Math.max(
    40,
    Math.floor((gridWidth.value - gridMargin * (columnCount.value + 1)) / columnCount.value),
  )
})
const gridStyle = computed(() => ({
  '--information-home-grid-track-size': `${rowHeight.value + gridMargin}px`,
}))
const desktopLayout = computed<Layout>(() =>
  props.widgets.map((widget) => ({ i: widget.id, ...widget.layout.desktop })),
)
const compactLayout = computed<Layout>(() => {
  let y = 0
  return props.widgets.map((widget) => {
    const position = widget.layout.compact ?? {
      x: 0,
      y,
      w: 6,
      h: widget.layout.desktop.h,
      minW: Math.min(widget.layout.desktop.minW ?? 2, 6),
      minH: widget.layout.desktop.minH,
    }
    y = Math.max(y, position.y + position.h)
    return { i: widget.id, ...position }
  })
})
const layout = computed<Layout>(() => (isCompact.value ? compactLayout.value : desktopLayout.value))
const responsiveLayouts = computed(() => ({
  lg: desktopLayout.value,
  md: desktopLayout.value,
  sm: compactLayout.value,
  xs: compactLayout.value,
  xxs: compactLayout.value,
}))
function updateLayout(next: Layout): void {
  if (!props.editing) return
  emit(
    'layout',
    Object.fromEntries(
      next.map((item) => [
        String(item.i),
        {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          ...(item.minW ? { minW: item.minW } : {}),
          ...(item.minH ? { minH: item.minH } : {}),
        },
      ]),
    ),
    isCompact.value ? 'compact' : 'desktop',
  )
}

function commitResize(id: string | number, height: number, width: number): void {
  emit('resize', String(id), { w: width, h: height }, isCompact.value ? 'compact' : 'desktop')
}

function commitMove(id: string | number, x: number, y: number): void {
  emit('move', String(id), { x, y }, isCompact.value ? 'compact' : 'desktop')
}

function syncGridWidth(): void {
  const next = Math.round(gridShell.value?.clientWidth ?? 0)
  if (next > 0 && next !== gridWidth.value) gridWidth.value = next
}

onMounted(() => {
  syncGridWidth()
  if (!gridShell.value || !globalThis.ResizeObserver) return
  gridResizeObserver = new globalThis.ResizeObserver(syncGridWidth)
  gridResizeObserver.observe(gridShell.value)
})
onBeforeUnmount(() => {
  gridResizeObserver?.disconnect()
  gridResizeObserver = null
})
</script>

<template>
  <div v-if="!widgets.length" class="dashboard-grid-empty">
    <strong>首页还没有卡片</strong>
  </div>
  <div v-else ref="gridShell" class="information-home-grid-shell">
    <GridLayout
      class="dashboard-grid information-home-grid"
      :style="gridStyle"
      :layout="layout"
      :responsive-layouts="responsiveLayouts"
      :col-num="12"
      :responsive="true"
      :breakpoints="{ lg: 1200, md: 900, sm: 640, xs: 400, xxs: 0 }"
      :cols="{ lg: 12, md: 12, sm: 6, xs: 6, xxs: 6 }"
      :row-height="rowHeight"
      :margin="[gridMargin, gridMargin]"
      :is-draggable="editing"
      :is-resizable="editing"
      :vertical-compact="true"
      :prevent-collision="false"
      :restore-on-drag="false"
      :use-css-transforms="true"
      @layout-updated="updateLayout"
      @breakpoint-changed="breakpoint = $event"
    >
      <GridItem
        v-for="widget in widgets"
        :key="widget.id"
        :i="widget.id"
        :x="(isCompact ? widget.layout.compact : widget.layout.desktop)?.x ?? 0"
        :y="(isCompact ? widget.layout.compact : widget.layout.desktop)?.y ?? 0"
        :w="(isCompact ? widget.layout.compact : widget.layout.desktop)?.w ?? 6"
        :h="
          (isCompact ? widget.layout.compact : widget.layout.desktop)?.h ?? widget.layout.desktop.h
        "
        :min-w="2"
        :min-h="2"
        :is-draggable="editing"
        :is-resizable="editing"
        drag-allow-from=".dashboard-widget-frame__drag-handle"
        drag-ignore-from="button, input, select, .dashboard-widget-frame__body"
        @moved="commitMove"
        @resized="commitResize"
      >
        <InformationHomeWidgetHost
          :widget="widget"
          :editing="editing"
          :summary="summary"
          :generating-summary="generatingSummary"
          :auto-summary-enabled="autoSummaryEnabled"
          :summary-interval-minutes="summaryIntervalMinutes"
          @copy="emit('copy', widget.id)"
          @remove="emit('remove', widget.id)"
          @open-email="emit('openEmail', $event)"
          @open-rss="emit('openRss', $event)"
          @generate-summary="emit('generateSummary')"
          @toggle-auto-summary="emit('toggleAutoSummary')"
          @change-summary-interval="emit('changeSummaryInterval')"
          @resize="emit('resize', widget.id, $event, isCompact ? 'compact' : 'desktop')"
          @update-settings="emit('updateSettings', widget.id, $event)"
        />
      </GridItem>
    </GridLayout>
  </div>
</template>
