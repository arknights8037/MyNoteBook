<script setup lang="ts">
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  Info,
  Pencil,
  Plus,
  Trash2,
} from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui'

import type { SidebarDocumentNode } from './documentTree'
import type { DocumentId, DocumentSummary } from '@/models/document'
import { NButton, NIcon, NTooltip } from '@/ui'

defineOptions({ name: 'SidebarDocumentTree' })

type BrowserDragEvent = InstanceType<typeof globalThis.DragEvent>

withDefaults(
  defineProps<{
    nodes: SidebarDocumentNode[]
    currentDocumentId: DocumentId
    collapsedDocumentIds: Set<DocumentId>
    draggedArticleId: DocumentId | null
    busy: boolean
    depth?: number
  }>(),
  {
    depth: 0,
  },
)

const emit = defineEmits<{
  select: [documentId: DocumentId]
  toggle: [documentId: DocumentId]
  createChild: [documentId: DocumentId]
  properties: [document: DocumentSummary]
  rename: [document: DocumentSummary]
  delete: [document: DocumentSummary]
  dragStart: [payload: { event: BrowserDragEvent; document: DocumentSummary }]
  dragEnd: []
}>()

function displayTitle(document: DocumentSummary): string {
  const title = document.title.trim()
  return title.length > 0 ? title : '未命名文档'
}
</script>

<template>
  <template v-for="node in nodes" :key="node.document.id">
    <div
      class="document-list__item document-list__item--article document-list__item--tree"
      :class="{
        'document-list__item--active': node.document.id === currentDocumentId,
        'document-list__item--dragging': node.document.id === draggedArticleId,
      }"
      :style="{ '--document-tree-depth': depth }"
      draggable="true"
      @dragstart="emit('dragStart', { event: $event, document: node.document })"
      @dragend="emit('dragEnd')"
    >
      <button
        v-if="node.children.length > 0"
        type="button"
        class="document-list__toggle"
        :aria-label="collapsedDocumentIds.has(node.document.id) ? '展开子页面' : '收起子页面'"
        @click.stop="emit('toggle', node.document.id)"
      >
        <ChevronRight v-if="collapsedDocumentIds.has(node.document.id)" :size="14" />
        <ChevronDown v-else :size="14" />
      </button>
      <span v-else class="document-list__toggle-spacer" aria-hidden="true"></span>

      <button
        type="button"
        class="document-list__select"
        :disabled="busy"
        @click="emit('select', node.document.id)"
      >
        <FileText :size="16" />
        <span class="document-list__main">
          <span class="document-list__title">{{ displayTitle(node.document) }}</span>
          <span v-if="node.children.length > 0" class="document-list__meta">
            {{ node.children.length }} 个子页面
          </span>
        </span>
      </button>

      <span class="document-list__actions document-list__actions--menu">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="document-list__more"
              size="tiny"
              quaternary
              :aria-label="`${displayTitle(node.document)}中新建子页面`"
              :disabled="busy"
              @click.stop="emit('createChild', node.document.id)"
              @dragstart.stop.prevent
            >
              <template #icon
                ><NIcon :size="14"><Plus /></NIcon
              ></template>
            </NButton>
          </template>
          新建子页面
        </NTooltip>

        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <NButton
              class="document-list__more"
              size="tiny"
              quaternary
              :aria-label="`${displayTitle(node.document)}更多操作`"
              :disabled="busy"
              @click.stop
              @dragstart.stop.prevent
            >
              <template #icon
                ><NIcon :size="15"><Ellipsis /></NIcon
              ></template>
            </NButton>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent class="document-card-menu" align="end" :side-offset="5">
              <DropdownMenuItem
                class="document-card-menu__item"
                @select="emit('createChild', node.document.id)"
              >
                <Plus :size="14" />新建子页面
              </DropdownMenuItem>
              <DropdownMenuItem
                class="document-card-menu__item"
                @select="emit('properties', node.document)"
              >
                <Info :size="14" />属性
              </DropdownMenuItem>
              <DropdownMenuItem
                class="document-card-menu__item"
                @select="emit('rename', node.document)"
              >
                <Pencil :size="14" />重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator class="document-card-menu__separator" />
              <DropdownMenuItem
                class="document-card-menu__item document-card-menu__item--danger"
                @select="emit('delete', node.document)"
              >
                <Trash2 :size="14" />删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </span>
    </div>

    <SidebarDocumentTree
      v-if="node.children.length > 0 && !collapsedDocumentIds.has(node.document.id)"
      :nodes="node.children"
      :current-document-id="currentDocumentId"
      :collapsed-document-ids="collapsedDocumentIds"
      :dragged-article-id="draggedArticleId"
      :busy="busy"
      :depth="depth + 1"
      @select="emit('select', $event)"
      @toggle="emit('toggle', $event)"
      @create-child="emit('createChild', $event)"
      @properties="emit('properties', $event)"
      @rename="emit('rename', $event)"
      @delete="emit('delete', $event)"
      @drag-start="emit('dragStart', $event)"
      @drag-end="emit('dragEnd')"
    />
  </template>
</template>
