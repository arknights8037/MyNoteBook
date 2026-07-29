<script setup lang="ts">
import { GridItem, GridLayout, type Layout } from 'grid-layout-plus'
import { computed, ref } from 'vue'

import type {
  InformationHomeGridPosition,
  InformationHomeSummary,
  InformationHomeWidget,
} from '@/models/home/informationHome'
import InformationHomeWidgetHost from './InformationHomeWidgetHost.vue'

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
  resize: [id: string, size: { w: number; h: number }]
  updateSettings: [id: string, settings: InformationHomeWidget['settings']]
}>()

const breakpoint = ref('lg')
const isCompact = computed(() => !['lg', 'md'].includes(breakpoint.value))
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
const resizeOption = {
  edges: {
    right: '.information-home-grid__resize-handle',
    bottom: '.information-home-grid__resize-handle',
    left: false,
    top: false,
  },
}

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
</script>

<template>
  <div v-if="!widgets.length" class="dashboard-grid-empty">
    <strong>首页还没有卡片</strong>
  </div>
  <GridLayout
    v-else
    class="dashboard-grid information-home-grid"
    :layout="layout"
    :responsive-layouts="responsiveLayouts"
    :col-num="12"
    :responsive="true"
    :breakpoints="{ lg: 1200, md: 900, sm: 640, xs: 400, xxs: 0 }"
    :cols="{ lg: 12, md: 12, sm: 6, xs: 6, xxs: 6 }"
    :row-height="72"
    :margin="[10, 10]"
    :is-draggable="editing"
    :is-resizable="editing"
    :vertical-compact="false"
    :prevent-collision="false"
    :restore-on-drag="true"
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
      :h="(isCompact ? widget.layout.compact : widget.layout.desktop)?.h ?? widget.layout.desktop.h"
      :min-w="2"
      :min-h="2"
      :is-draggable="editing"
      :is-resizable="editing"
      :resize-option="resizeOption"
      drag-allow-from=".dashboard-widget-frame__drag-handle"
      drag-ignore-from="button, input, select, .dashboard-widget-frame__body, .information-home-grid__resize-handle"
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
        @resize="emit('resize', widget.id, $event)"
        @update-settings="emit('updateSettings', widget.id, $event)"
      />
      <span
        v-if="editing"
        class="information-home-grid__resize-handle"
        role="separator"
        aria-label="拖动调整卡片大小"
        aria-orientation="horizontal"
        title="拖动调整卡片大小"
      />
    </GridItem>
  </GridLayout>
</template>
