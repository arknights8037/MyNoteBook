<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  Bot,
  BrainCircuit,
  Copy,
  FileText,
  LayoutGrid,
  Minus,
  Plus,
  Settings,
  Square,
  X,
} from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'

export interface WorkspaceTab {
  key: string
  kind: 'document' | 'mindmap' | 'view' | 'surface'
  id: string
  title: string
}

defineProps<{
  tabs: WorkspaceTab[]
  activeKey: string
}>()

const emit = defineEmits<{
  activate: [tab: WorkspaceTab]
  close: [key: string]
  create: []
}>()

const isMaximized = ref(false)
let stopResizeListener: (() => void) | null = null
let disposed = false

function currentWindow() {
  return Reflect.has(globalThis, '__TAURI_INTERNALS__') ? getCurrentWindow() : null
}

async function syncMaximizedState(): Promise<void> {
  const appWindow = currentWindow()
  if (!appWindow) return
  const maximized = await appWindow.isMaximized()
  isMaximized.value = maximized
  globalThis.document.documentElement.dataset.windowMaximized = String(maximized)
}

async function minimizeWindow(): Promise<void> {
  await currentWindow()?.minimize()
}

async function toggleMaximizedWindow(): Promise<void> {
  await currentWindow()?.toggleMaximize()
  await syncMaximizedState()
}

async function closeWindow(): Promise<void> {
  await currentWindow()?.close()
}

onMounted(async () => {
  const appWindow = currentWindow()
  if (!appWindow) {
    globalThis.document.documentElement.dataset.windowMaximized = 'false'
    return
  }
  await syncMaximizedState()
  const unlisten = await appWindow.onResized(() => void syncMaximizedState())
  if (disposed) unlisten()
  else stopResizeListener = unlisten
})

onBeforeUnmount(() => {
  disposed = true
  stopResizeListener?.()
})

function iconFor(tab: WorkspaceTab) {
  if (tab.kind === 'document') return FileText
  if (tab.kind === 'mindmap') return BrainCircuit
  if (tab.kind === 'view') return LayoutGrid
  return tab.id === 'agent' ? Bot : Settings
}
</script>

<template>
  <header class="workspace-tabs" aria-label="打开的页面">
    <div class="workspace-tabs__scroll" role="tablist">
      <div
        v-for="tab in tabs"
        :key="tab.key"
        role="tab"
        tabindex="0"
        class="workspace-tab"
        :class="{ 'workspace-tab--active': tab.key === activeKey }"
        :aria-selected="tab.key === activeKey"
        :title="tab.title"
        @click="emit('activate', tab)"
        @keydown.enter="emit('activate', tab)"
        @keydown.space.prevent="emit('activate', tab)"
        @auxclick.middle.prevent="emit('close', tab.key)"
      >
        <component :is="iconFor(tab)" :size="14" />
        <span>{{ tab.title }}</span>
        <i v-if="tab.key === activeKey" aria-hidden="true" />
        <button
          type="button"
          class="workspace-tab__close"
          :aria-label="`关闭 ${tab.title}`"
          @click.stop="emit('close', tab.key)"
        >
          <X :size="13" />
        </button>
      </div>
    </div>
    <button
      type="button"
      class="workspace-tabs__new"
      aria-label="新建内容"
      title="新建内容"
      @click="emit('create')"
    >
      <Plus :size="16" />
    </button>
    <div
      class="workspace-tabs__drag-region"
      data-tauri-drag-region
      aria-hidden="true"
      @dblclick="toggleMaximizedWindow"
    ></div>
    <span class="workspace-tabs__window-divider" aria-hidden="true">|</span>
    <div class="workspace-tabs__window-controls" aria-label="窗口控制">
      <button type="button" aria-label="最小化窗口" title="最小化" @click="minimizeWindow">
        <Minus :size="15" />
      </button>
      <button
        type="button"
        :aria-label="isMaximized ? '还原窗口' : '最大化窗口'"
        :title="isMaximized ? '还原' : '最大化'"
        @click="toggleMaximizedWindow"
      >
        <Copy v-if="isMaximized" :size="13" />
        <Square v-else :size="13" />
      </button>
      <button
        type="button"
        class="workspace-tabs__window-close"
        aria-label="关闭窗口"
        title="关闭"
        @click="closeWindow"
      >
        <X :size="16" />
      </button>
    </div>
  </header>
</template>
