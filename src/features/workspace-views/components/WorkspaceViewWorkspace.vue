<script setup lang="ts">
import { Download, GitBranch, Presentation, Save, Share2, Table2 } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { createWorkspaceViewService } from '@/app/composition/workspaceViewServiceFactory'
import { applyTableFieldsToRows } from '@/editor/tableFields'
import type {
  StructuredWorkspaceView,
  StructuredWorkspaceViewPayload,
  StructuredWorkspaceViewSummary,
} from '@/models/workspaceView'
import type { WorkspaceViewService } from '@/services/WorkspaceViewService'
import { NButton, NDrawer, NDrawerContent, NIcon, NTooltip } from '@/ui'
import SlidesViewEditor from './SlidesViewEditor.vue'
import TableViewEditor from './TableViewEditor.vue'
import UmlViewEditor from './UmlViewEditor.vue'

const props = defineProps<{ viewId: string }>()
const emit = defineEmits<{ saved: [summary: StructuredWorkspaceViewSummary] }>()

const view = ref<StructuredWorkspaceView | null>(null)
const payload = ref<StructuredWorkspaceViewPayload | null>(null)
const status = ref('正在加载')
const error = ref('')
const showInspector = ref(false)
let servicePromise: Promise<WorkspaceViewService> | null = null
let timer: ReturnType<typeof globalThis.setTimeout> | null = null
let saving: Promise<void> | null = null
let draft = 0
let persisted = 0
let generation = 0

const viewIcon = computed(() => {
  if (payload.value?.type === 'slides') return Presentation
  if (payload.value?.type === 'uml') return GitBranch
  return Table2
})

const inspectorValue = computed(() =>
  view.value && payload.value
    ? JSON.stringify({ ...view.value, payload: payload.value }, null, 2)
    : '',
)

const service = () => (servicePromise ??= createWorkspaceViewService())

async function load(id: string): Promise<void> {
  const current = ++generation
  await flush()
  if (current !== generation) return

  status.value = '正在加载'
  error.value = ''
  const result = await (await service()).get(id)
  if (current !== generation) return
  if (!result.ok) {
    error.value = result.error.message
    status.value = '加载失败'
    view.value = null
    payload.value = null
    return
  }

  view.value = result.value
  payload.value = result.value.payload
  draft = 0
  persisted = 0
  status.value = '已保存'
}

function change(next: StructuredWorkspaceViewPayload): void {
  payload.value = next
  draft += 1
  status.value = '等待保存'
  if (timer) globalThis.clearTimeout(timer)
  timer = globalThis.setTimeout(() => void flush().catch(showError), 500)
}

function updateTitle(value: string): void {
  if (!view.value || !payload.value) return
  view.value = { ...view.value, title: value }
  change(payload.value)
}

function flush(): Promise<void> {
  if (saving) return saving
  if (persisted >= draft) return Promise.resolve()
  saving = runSave().finally(() => {
    saving = null
  })
  return saving
}

async function runSave(): Promise<void> {
  while (view.value && payload.value && persisted < draft) {
    const current = view.value
    const next = payload.value
    const revision = draft
    const title = current.title.trim()
    if (!title) {
      status.value = '标题不能为空'
      return
    }

    status.value = '正在保存'
    const result = await (await service()).update({
      id: current.id,
      expectedVersion: current.version,
      title,
      payload: next,
    })
    if (!result.ok) {
      status.value = '保存失败'
      throw new Error(result.error.message)
    }

    persisted = revision
    view.value =
      draft === revision
        ? result.value
        : { ...result.value, title: view.value.title, payload: payload.value }
    status.value = persisted === draft ? '已保存' : '等待保存'
    emit('saved', toSummary(result.value))
  }
}

function toSummary(value: StructuredWorkspaceView): StructuredWorkspaceViewSummary {
  return {
    id: value.id,
    parentId: value.parentId,
    sortOrder: value.sortOrder,
    viewType: value.viewType,
    title: value.title,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function showError(value: unknown): void {
  error.value = value instanceof Error ? value.message : String(value)
}

async function exportView(): Promise<void> {
  if (!view.value || !payload.value) return

  try {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ])
    const exported = serializeForExport(view.value, payload.value)
    const path = await save({
      defaultPath: `${safeFileName(view.value.title)}.${exported.extension}`,
      filters: [{ name: exported.label, extensions: [exported.extension] }],
    })
    if (!path) return
    await writeTextFile(path, exported.content)
  } catch (exportError) {
    showError(exportError)
  }
}

function serializeForExport(
  currentView: StructuredWorkspaceView,
  currentPayload: StructuredWorkspaceViewPayload,
): { content: string; extension: string; label: string } {
  if (currentPayload.type === 'uml') {
    return { content: currentPayload.source, extension: 'mmd', label: 'Mermaid 流程图' }
  }
  if (currentPayload.type === 'table') {
    const rows = applyTableFieldsToRows(currentPayload.rows, currentPayload.fields)
    return {
      content: rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n'),
      extension: 'csv',
      label: 'CSV 表格',
    }
  }
  return {
    content: JSON.stringify({ ...currentView, payload: currentPayload }, null, 2),
    extension: 'json',
    label: '幻灯片 JSON',
  }
}

function escapeCsvCell(value: string): string {
  const cell = String(value ?? '')
  return /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

function safeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*]/g, '_') || '未命名视图'
}

watch(
  () => props.viewId,
  (id) => void load(id),
  { immediate: true },
)

onBeforeUnmount(() => {
  if (timer) globalThis.clearTimeout(timer)
  void flush().catch(() => undefined)
})
</script>

<template>
  <section class="structured-view-workspace">
    <header class="topbar structured-view-workspace__header">
      <div class="topbar__title structured-view-workspace__title">
        <component :is="viewIcon" :size="18" />
        <input
          :value="view?.title ?? ''"
          :disabled="!view"
          maxlength="160"
          aria-label="视图标题"
          @input="updateTitle(($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="topbar__actions">
        <span><NIcon :size="14"><Save /></NIcon>{{ status }}</span>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="topbar__icon-button"
              quaternary
              circle
              aria-label="导出视图"
              :disabled="!view || !payload"
              @click="exportView"
            >
              <template #icon><NIcon :size="19"><Download /></NIcon></template>
            </NButton>
          </template>
          导出当前视图
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="topbar__icon-button"
              quaternary
              circle
              aria-label="开发面板"
              :disabled="!view"
              @click="showInspector = true"
            >
              <template #icon><NIcon :size="19"><Share2 /></NIcon></template>
            </NButton>
          </template>
          开发面板
        </NTooltip>
      </div>
    </header>

    <p v-if="error" role="alert">{{ error }}</p>
    <SlidesViewEditor v-if="payload?.type === 'slides'" :payload="payload" @update="change" />
    <UmlViewEditor v-else-if="payload?.type === 'uml'" :payload="payload" @update="change" />
    <TableViewEditor v-else-if="payload?.type === 'table'" :payload="payload" @update="change" />
    <div v-else class="structured-view-workspace__empty">正在加载视图…</div>

    <NDrawer v-model:show="showInspector" :width="420" placement="right">
      <NDrawerContent class="editor-inspector-content" title="开发面板" closable>
        <section v-if="error"><h2>Error</h2><p>{{ error }}</p></section>
        <section><h2>Autosave</h2><p>状态：{{ status }}</p></section>
        <section><h2>View payload</h2><pre>{{ inspectorValue }}</pre></section>
      </NDrawerContent>
    </NDrawer>
  </section>
</template>
