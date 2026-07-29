<script setup lang="ts">
import { GridItem, GridLayout, type Layout } from 'grid-layout-plus'
import { computed, ref } from 'vue'

import type { AgentTask } from '@/models/agent/agent'
import type {
  DashboardGridPosition,
  DashboardWidgetInstance,
} from '@/models/workspace/workspaceView'
import type { AutomationService } from '@/services/automation/AutomationService'
import DashboardWidgetHost from './DashboardWidgetHost.vue'

const props = defineProps<{
  widgets: DashboardWidgetInstance[]
  editing: boolean
  agentTasks: AgentTask[]
  getAutomationService: () => Promise<AutomationService>
}>()
const emit = defineEmits<{
  layout: [positions: Record<string, DashboardGridPosition>, target: 'desktop' | 'compact']
  copy: [id: string]
  remove: [id: string]
}>()

const breakpoint = ref('lg')
const isCompact = computed(() => !['lg', 'md'].includes(breakpoint.value))
const desktopLayout = computed<Layout>(() =>
  props.widgets.map((widget) => ({
    i: widget.id,
    ...widget.layout.desktop,
  })),
)
const compactLayout = computed<Layout>(() => {
  let y = 0
  return props.widgets.map((widget) => {
    const saved = widget.layout.compact
    const position = saved ?? {
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
</script>

<template>
  <div v-if="!widgets.length" class="dashboard-grid-empty">
    <strong>这个信息面板还是空的</strong>
  </div>
  <GridLayout
    v-else
    class="dashboard-grid"
    :layout="layout"
    :responsive-layouts="responsiveLayouts"
    :col-num="12"
    :responsive="true"
    :breakpoints="{ lg: 1200, md: 900, sm: 640, xs: 400, xxs: 0 }"
    :cols="{ lg: 12, md: 12, sm: 6, xs: 6, xxs: 6 }"
    :row-height="78"
    :margin="[16, 16]"
    :is-draggable="editing"
    :is-resizable="editing"
    :vertical-compact="true"
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
      :min-w="widget.layout.desktop.minW ?? 2"
      :min-h="widget.layout.desktop.minH ?? 2"
      :is-draggable="editing"
      :is-resizable="editing"
      drag-allow-from=".dashboard-widget-frame__drag-handle"
      drag-ignore-from="button, input, .dashboard-widget-frame__body"
    >
      <DashboardWidgetHost
        :widget="widget"
        :editing="editing"
        :agent-tasks="agentTasks"
        :get-automation-service="getAutomationService"
        @copy="emit('copy', widget.id)"
        @remove="emit('remove', widget.id)"
      />
    </GridItem>
  </GridLayout>
</template>
