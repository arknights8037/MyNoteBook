<script setup lang="ts">
import { Download, Network, Save, Share2 } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import {
  mindMapToDirectionalText,
  type MindMapContent,
  type MindMapDocument,
  type MindMapSummary,
} from '@/models/workspace/mindMap'
import type { MindMapService } from '@/services/workspace/MindMapService'
import { NButton, NDrawer, NDrawerContent, NIcon, NTooltip } from '@/ui'
import MindMapEditor from './MindMapEditor.vue'

const props = defineProps<{
  mindMapId: string
  getService: () => Promise<MindMapService>
}>()
const emit = defineEmits<{
  saved: [summary: MindMapSummary]
}>()

const document = ref<MindMapDocument | null>(null)
const draftContent = ref<MindMapContent | null>(null)
const loading = ref(false)
const saving = ref(false)
const status = ref('正在加载')
const error = ref('')
const showInspector = ref(false)
let servicePromise: Promise<MindMapService> | null = null
let saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let savePromise: Promise<void> | null = null
let draftRevision = 0
let persistedRevision = 0
let loadGeneration = 0

const directionalText = computed(() => {
  if (!document.value || !draftContent.value) return ''
  return mindMapToDirectionalText({ ...document.value, content: draftContent.value })
})

function service(): Promise<MindMapService> {
  return (servicePromise ??= props.getService())
}

async function load(id: string): Promise<void> {
  const generation = ++loadGeneration
  await flush()
  if (generation !== loadGeneration) return
  loading.value = true
  error.value = ''
  try {
    const result = await (await service()).get(id)
    if (generation !== loadGeneration) return
    if (!result.ok) throw new Error(result.error.message)
    document.value = result.value
    draftContent.value = result.value.content
    draftRevision = 0
    persistedRevision = 0
    status.value = '已保存'
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
    status.value = '加载失败'
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

function updateContent(content: MindMapContent): void {
  draftContent.value = content
  markDirty()
}

function updateTitle(title: string): void {
  if (!document.value) return
  document.value = { ...document.value, title }
  markDirty()
}

function markDirty(): void {
  draftRevision += 1
  status.value = '等待保存'
  if (saveTimer) globalThis.clearTimeout(saveTimer)
  saveTimer = globalThis.setTimeout(() => {
    void flush().catch((saveError) => {
      error.value = saveError instanceof Error ? saveError.message : String(saveError)
    })
  }, 500)
}

function flush(): Promise<void> {
  if (savePromise) return savePromise
  if (persistedRevision >= draftRevision) return Promise.resolve()
  savePromise = runSave().finally(() => {
    savePromise = null
  })
  return savePromise
}

async function runSave(): Promise<void> {
  saving.value = true
  try {
    while (document.value && draftContent.value && persistedRevision < draftRevision) {
      const current = document.value
      const content = draftContent.value
      const title = current.title.trim()
      const capturedRevision = draftRevision
      if (!title) {
        status.value = '标题不能为空'
        return
      }
      status.value = '正在保存'
      const result = await (
        await service()
      ).update({
        id: current.id,
        expectedVersion: current.version,
        title,
        content,
      })
      if (!result.ok) {
        status.value =
          result.error.code === 'revision-conflict' ? '版本冲突，请重新打开' : '保存失败'
        throw new Error(result.error.message)
      }
      persistedRevision = capturedRevision
      document.value =
        draftRevision === capturedRevision
          ? result.value
          : { ...result.value, title: document.value.title, content: draftContent.value }
      status.value = persistedRevision === draftRevision ? '已保存' : '等待保存'
      emit('saved', toSummary(result.value))
    }
  } finally {
    saving.value = false
  }
}

function toSummary(value: MindMapDocument): MindMapSummary {
  return {
    id: value.id,
    parentId: value.parentId,
    sortOrder: value.sortOrder,
    title: value.title,
    rootNodeId: value.content.rootNodeId,
    nodeCount: Object.keys(value.content.nodes).length,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

async function exportMindMap(format: 'json' | 'text' = 'json'): Promise<void> {
  if (!document.value || !draftContent.value) return
  try {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ])
    const suffix = format === 'json' ? 'mindmap.json' : 'mindmap.txt'
    const path = await save({
      defaultPath: `${safeFileName(document.value.title)}.${suffix}`,
      filters: [
        {
          name: format === 'json' ? '思维导图 JSON' : 'AI 指向性文本',
          extensions: [format === 'json' ? 'json' : 'txt'],
        },
      ],
    })
    if (!path) return
    const value = { ...document.value, content: draftContent.value }
    await writeTextFile(
      path,
      format === 'json' ? JSON.stringify(value, null, 2) : mindMapToDirectionalText(value),
    )
  } catch (exportError) {
    error.value = exportError instanceof Error ? exportError.message : String(exportError)
  }
}

function safeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*]/g, '_') || '未命名思维导图'
}

watch(
  () => props.mindMapId,
  (id) => void load(id),
  { immediate: true },
)

onBeforeUnmount(() => {
  if (saveTimer) globalThis.clearTimeout(saveTimer)
  void flush().catch(() => undefined)
})
</script>

<template>
  <section class="mind-map-workspace-view">
    <header class="topbar mind-map-workspace-view__header">
      <div class="topbar__title mind-map-workspace-view__title">
        <Network :size="18" />
        <input
          :value="document?.title ?? ''"
          :disabled="loading || !document"
          maxlength="160"
          aria-label="思维导图标题"
          @input="updateTitle(($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="topbar__actions">
        <span :class="{ 'is-saving': saving }">
          <NIcon :size="14"><Save /></NIcon>{{ status }}
        </span>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="topbar__icon-button"
              quaternary
              circle
              aria-label="导出思维导图"
              @click="exportMindMap('json')"
            >
              <template #icon
                ><NIcon :size="19"><Download /></NIcon
              ></template>
            </NButton>
          </template>
          导出思维导图 JSON
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="topbar__icon-button"
              quaternary
              circle
              aria-label="开发面板"
              @click="showInspector = true"
            >
              <template #icon
                ><NIcon :size="19"><Share2 /></NIcon
              ></template>
            </NButton>
          </template>
          开发面板
        </NTooltip>
      </div>
    </header>
    <p v-if="error" class="mind-map-workspace-view__error" role="alert">{{ error }}</p>
    <MindMapEditor
      v-if="document && draftContent"
      :key="document.id"
      :content="draftContent"
      @change="updateContent"
      @export="exportMindMap('json')"
      @inspect="showInspector = true"
    />
    <div v-else-if="loading" class="mind-map-workspace-view__empty">正在加载思维导图…</div>
    <NDrawer v-model:show="showInspector" :width="420" placement="right">
      <NDrawerContent class="editor-inspector-content" title="开发面板" closable>
        <section v-if="error">
          <h2>Error</h2>
          <p>{{ error }}</p>
        </section>
        <section>
          <h2>Autosave</h2>
          <p>状态：{{ status }}</p>
        </section>
        <section>
          <h2>AI 指向性文本</h2>
          <pre>{{ directionalText }}</pre>
          <NButton size="small" secondary @click="exportMindMap('text')">导出文本</NButton>
        </section>
        <section>
          <h2>JSON</h2>
          <pre>{{ draftContent ? JSON.stringify(draftContent, null, 2) : '' }}</pre>
        </section>
      </NDrawerContent>
    </NDrawer>
  </section>
</template>
