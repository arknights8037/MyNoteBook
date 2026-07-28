<script setup lang="ts">
import { Boxes, Check, Pencil, RotateCcw, Undo2, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import type { AgentTask } from '@/models/agent/agent'
import {
  createDefaultDashboardPayload,
  type DashboardGridPosition,
  type DashboardViewPayload,
  type DashboardWidgetInstance,
  type DashboardWidgetType,
} from '@/models/workspace/workspaceView'
import type { AutomationService } from '@/services/automation/AutomationService'
import { getDashboardWidgetDefinition } from '../dashboardWidgetRegistry'
import DashboardGrid from './DashboardGrid.vue'
import DashboardWidgetLibrary from './DashboardWidgetLibrary.vue'

const props = defineProps<{
  payload: DashboardViewPayload
  agentTasks: AgentTask[]
  getAutomationService: () => Promise<AutomationService>
}>()
const emit = defineEmits<{ update: [payload: DashboardViewPayload] }>()

const editing = ref(false)
const showLibrary = ref(false)
const draft = ref<DashboardViewPayload>(clonePayload(props.payload))
const undoStack = ref<DashboardViewPayload[]>([])
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.payload))

watch(
  () => props.payload,
  (payload) => {
    if (!editing.value || !dirty.value) draft.value = clonePayload(payload)
  },
  { deep: true },
)

function beginEdit(): void {
  draft.value = clonePayload(props.payload)
  undoStack.value = []
  editing.value = true
}

function cancelEdit(): void {
  draft.value = clonePayload(props.payload)
  undoStack.value = []
  showLibrary.value = false
  editing.value = false
}

function save(): void {
  emit('update', clonePayload(draft.value))
  undoStack.value = []
  showLibrary.value = false
  editing.value = false
}

function mutate(mutator: (payload: DashboardViewPayload) => void): void {
  undoStack.value.push(clonePayload(draft.value))
  if (undoStack.value.length > 30) undoStack.value.shift()
  const next = clonePayload(draft.value)
  mutator(next)
  draft.value = next
}

function undo(): void {
  const previous = undoStack.value.pop()
  if (previous) draft.value = previous
}

function reset(): void {
  mutate((payload) => {
    payload.widgets = createDefaultDashboardPayload(createId).widgets
  })
}

function addWidget(type: DashboardWidgetType): void {
  mutate((payload) => payload.widgets.push(createWidget(type, payload.widgets)))
}

function copyWidget(id: string): void {
  mutate((payload) => {
    const source = payload.widgets.find((widget) => widget.id === id)
    if (!source) return
    const copy = cloneWidget(source)
    copy.id = createId('dashboard-widget')
    copy.layout.desktop.y = bottomRow(payload.widgets)
    payload.widgets.push(copy)
  })
}

function removeWidget(id: string): void {
  mutate((payload) => {
    payload.widgets = payload.widgets.filter((widget) => widget.id !== id)
  })
}

function updateLayout(
  positions: Record<string, DashboardGridPosition>,
  target: 'desktop' | 'compact',
): void {
  if (!editing.value) return
  const current = JSON.stringify(draft.value.widgets.map((widget) => widget.layout[target]))
  const next = JSON.stringify(
    draft.value.widgets.map((widget) => positions[widget.id] ?? widget.layout[target]),
  )
  if (current === next) return
  mutate((payload) => {
    payload.widgets = payload.widgets.map((widget) => ({
      ...widget,
      layout: { ...widget.layout, [target]: positions[widget.id] ?? widget.layout[target] },
    }))
  })
}

function createWidget(
  type: DashboardWidgetType,
  widgets: DashboardWidgetInstance[],
): DashboardWidgetInstance {
  const definition = getDashboardWidgetDefinition(type)
  return {
    id: createId('dashboard-widget'),
    widgetType: type,
    widgetVersion: 1,
    query: { limit: 8 },
    settings: type === 'agent-work-status' ? { showCompleted: true } : {},
    layout: {
      desktop: { x: 0, y: bottomRow(widgets), ...definition.defaultSize },
    },
  }
}

function bottomRow(widgets: DashboardWidgetInstance[]): number {
  return widgets.reduce(
    (bottom, widget) => Math.max(bottom, widget.layout.desktop.y + widget.layout.desktop.h),
    0,
  )
}

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

function cloneWidget(widget: DashboardWidgetInstance): DashboardWidgetInstance {
  return cloneJson(widget)
}

function clonePayload(payload: DashboardViewPayload): DashboardViewPayload {
  return cloneJson(payload)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
</script>

<template>
  <section class="dashboard-surface" :class="{ 'dashboard-surface--editing': editing }">
    <header class="dashboard-toolbar">
      <div>
        <span class="dashboard-toolbar__eyebrow">WORKSPACE OVERVIEW</span>
        <strong>{{ editing ? '正在编排信息面板' : '实时工作概览' }}</strong>
        <small>{{ draft.widgets.length }} 个组件 · 只读数据源</small>
      </div>
      <div class="dashboard-toolbar__actions">
        <template v-if="editing">
          <button type="button" @click="showLibrary = !showLibrary">
            <Boxes :size="16" />组件库
          </button>
          <button type="button" :disabled="!undoStack.length" @click="undo">
            <Undo2 :size="16" />撤销
          </button>
          <button type="button" @click="reset"><RotateCcw :size="16" />恢复默认</button>
          <button type="button" @click="cancelEdit"><X :size="16" />取消</button>
          <button type="button" class="dashboard-toolbar__primary" :disabled="!dirty" @click="save">
            <Check :size="16" />保存布局
          </button>
        </template>
        <button v-else type="button" class="dashboard-toolbar__primary" @click="beginEdit">
          <Pencil :size="16" />编辑面板
        </button>
      </div>
    </header>
    <div class="dashboard-surface__workspace">
      <DashboardGrid
        :widgets="draft.widgets"
        :editing="editing"
        :agent-tasks="agentTasks"
        :get-automation-service="getAutomationService"
        @layout="updateLayout"
        @copy="copyWidget"
        @remove="removeWidget"
      />
      <Transition name="dashboard-library">
        <DashboardWidgetLibrary
          v-if="editing && showLibrary"
          @add="addWidget"
          @close="showLibrary = false"
        />
      </Transition>
    </div>
  </section>
</template>
