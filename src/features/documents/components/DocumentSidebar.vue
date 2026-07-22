<script setup lang="ts">
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from '@lucide/vue'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { computed, ref } from 'vue'

import SidebarDocumentTree from './SidebarDocumentTree.vue'
import {
  displayDocumentTitle,
  formatDocumentUpdatedAt,
} from '@/models/documents/documentPresentation'
import {
  buildSidebarDocumentForest,
  countSidebarDocumentNodes,
} from '@/models/documents/documentTree'
import type { DocumentId, DocumentSummary } from '@/models/documents/document'
import type { MindMapSummary } from '@/models/workspace/mindMap'
import type { DocumentSidebarView, WorkspaceSurface } from '@/models/workspace/workspaceSurface'
import type { StructuredWorkspaceViewSummary } from '@/models/workspace/workspaceView'
import NButton from '@/ui/NButton.vue'
import NIcon from '@/ui/NIcon.vue'
import NTooltip from '@/ui/NTooltip.vue'

export type SidebarView = DocumentSidebarView
export type { WorkspaceSurface } from '@/models/workspace/workspaceSurface'
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserDragEvent = InstanceType<typeof globalThis.DragEvent>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const props = withDefaults(defineProps<{
  documents: DocumentSummary[]
  deletedDocuments: DocumentSummary[]
  view: SidebarView
  activeSurface: WorkspaceSurface
  currentDocumentId: DocumentId
  selectedGroupId: DocumentId | null
  collapsedGroupIds: Set<DocumentId>
  collapsedDocumentIds: Set<DocumentId>
  draggedArticleId: DocumentId | null
  draggedMindMapId?: string | null
  draggedWorkspaceViewId?: string | null
  dropTargetGroupId: DocumentId | null
  importFileAccept: string
  busy: boolean
  mindMaps: MindMapSummary[]
  activeMindMapId: string | null
  workspaceViews: StructuredWorkspaceViewSummary[]
  activeWorkspaceViewId: string | null
}>(), {
  draggedMindMapId: null,
  draggedWorkspaceViewId: null,
})

const emit = defineEmits<{
  search: []
  agent: []
  'new-view': []
  plugins: []
  automations: []
  audit: []
  knowledge: []
  settings: []
  import: []
  'file-change': [event: BrowserEvent]
  'create-group': []
  'create-document': [parentId: DocumentId | null]
  'create-mind-map': [parentId: string | null]
  'create-view': [parentId: string | null]
  'update:view': [view: SidebarView]
  'toggle-group': [groupId: DocumentId]
  'select-document': [documentId: DocumentId]
  'select-mind-map': [mindMapId: string]
  'delete-mind-map': [mindMapId: string]
  'delete-workspace-view': [viewId: string]
  'rename-mind-map': [mindMapId: string]
  'properties-mind-map': [mindMapId: string]
  'rename-workspace-view': [viewId: string]
  'properties-workspace-view': [viewId: string]
  'pin-workspace-view': [viewId: string]
  'select-workspace-view': [viewId: string]
  'toggle-document': [documentId: DocumentId]
  properties: [document: DocumentSummary]
  rename: [document: DocumentSummary]
  delete: [document: DocumentSummary]
  restore: [document: DocumentSummary]
  'permanently-delete': [document: DocumentSummary]
  'article-drag-start': [event: BrowserDragEvent, document: DocumentSummary]
  'article-drag-end': []
  'mind-map-drag-start': [event: BrowserDragEvent, mindMapId: string]
  'workspace-view-drag-start': [event: BrowserDragEvent, viewId: string]
  'group-drag-over': [event: BrowserDragEvent, groupId: DocumentId]
  'group-drag-leave': [event: BrowserDragEvent, groupId: DocumentId]
  'group-drop': [event: BrowserDragEvent, groupId: DocumentId]
}>()

const fileInput = ref<BrowserInputElement | null>(null)
const activeDocumentId = computed(() =>
  props.activeMindMapId || props.activeWorkspaceViewId ? '' : props.currentDocumentId,
)
const mindMapIds = computed(() => new Set(props.mindMaps.map((mindMap) => mindMap.id)))
const workspaceViewIds = computed(() => new Set(props.workspaceViews.map((view) => view.id)))
const workspaceViewTypes = computed(() => Object.fromEntries(props.workspaceViews.map((view) => [view.id, view.viewType])))
const workspaceViewPinnedAt = computed(() => Object.fromEntries(props.workspaceViews.map((view) => [view.id, view.pinnedAt])))
const sidebarPages = computed<DocumentSummary[]>(() => [
  ...props.documents,
  ...props.mindMaps.map((mindMap) => ({
    id: mindMap.id,
    parentId: mindMap.parentId,
    documentKind: 'article' as const,
    title: mindMap.title,
    tags: [],
    sourceUrl: '',
    author: '',
    description: `${mindMap.nodeCount} 个节点`,
    plainText: '',
    revision: mindMap.version,
    sortOrder: mindMap.sortOrder,
    isDeleted: false,
    createdAt: mindMap.createdAt,
    updatedAt: mindMap.updatedAt,
  })),
  ...props.workspaceViews.map((workspaceView) => ({
    id: workspaceView.id,
    parentId: workspaceView.parentId,
    documentKind: 'article' as const,
    title: workspaceView.title,
    tags: [],
    sourceUrl: '',
    author: '',
    description: workspaceView.viewType === 'table' ? '表格' : workspaceView.viewType === 'uml' ? 'UML / 流程图' : '幻灯片',
    plainText: '',
    revision: workspaceView.version,
    sortOrder: workspaceView.sortOrder,
    isDeleted: false,
    createdAt: workspaceView.createdAt,
    updatedAt: workspaceView.updatedAt,
  })),
].sort((left, right) => {
  const leftPinned = workspaceViewPinnedAt.value[left.id] ?? null
  const rightPinned = workspaceViewPinnedAt.value[right.id] ?? null
  if (leftPinned !== null || rightPinned !== null) {
    if (leftPinned === null) return 1
    if (rightPinned === null) return -1
    return rightPinned - leftPinned
  }
  return left.sortOrder - right.sortOrder || right.updatedAt - left.updatedAt
}))
const documentForest = computed(() => buildSidebarDocumentForest(sidebarPages.value))
const articleGroups = computed(() =>
  props.documents.filter(
    (document) => document.documentKind === 'group' && document.parentId === null,
  ),
)
const ungroupedArticleNodes = computed(() => documentForest.value.rootNodes)

function openFilePicker(): void {
  fileInput.value?.click()
}

function getGroupArticleNodes(groupId: DocumentId) {
  return documentForest.value.nodesByGroup.get(groupId) ?? []
}

function getGroupArticleCount(groupId: DocumentId): number {
  return countSidebarDocumentNodes(getGroupArticleNodes(groupId))
}

function canDropArticleIntoGroup(groupId: DocumentId): boolean {
  const mindMap = props.mindMaps.find((item) => item.id === props.draggedMindMapId)
  if (mindMap) return mindMap.parentId !== groupId
  const workspaceView = props.workspaceViews.find((item) => item.id === props.draggedWorkspaceViewId)
  if (workspaceView) return workspaceView.parentId !== groupId
  const article = props.documents.find((document) => document.id === props.draggedArticleId)
  return article?.documentKind === 'article' && article.parentId !== groupId
}

function toggleView(): void {
  emit('update:view', props.view === 'trash' ? 'documents' : 'trash')
}

defineExpose({ openFilePicker })
</script>

<template>
  <aside class="document-sidebar" aria-label="文档管理">
    <header class="sidebar-brand">
      <button type="button" class="sidebar-search-trigger" @click="emit('search')">
        <Search :size="15" />
        <span>搜索空间内容</span>
        <kbd>Ctrl K</kbd>
      </button>
    </header>

    <div v-if="view === 'documents'" class="context-sidebar__actions context-sidebar__actions--documents">
      <button type="button" :disabled="busy" @click="emit('create-group')">
        <Folder :size="15" /><span>新建分组</span>
      </button>
      <button type="button" :disabled="busy" @click="emit('create-view', null)">
        <Plus :size="15" /><span>新建内容</span>
      </button>
      <button type="button" @click="emit('import')">
        <Upload :size="15" /><span>导入文档</span>
      </button>
    </div>

    <div class="sidebar-section-heading">
      <span>{{ view === 'trash' ? '回收站' : '空间资源' }}</span>
    </div>
    <input
      ref="fileInput"
      class="file-input-hidden"
      type="file"
      :accept="importFileAccept"
      @change="emit('file-change', $event)"
    />

    <div v-if="view === 'documents'" class="document-list">
      <div v-for="group in articleGroups" :key="group.id" class="document-group">
        <ContextMenuRoot>
          <ContextMenuTrigger as-child>
            <div
              class="document-list__item document-list__item--group"
              :class="{
                'document-list__item--active': selectedGroupId === group.id,
                'document-list__item--drop-available': canDropArticleIntoGroup(group.id),
                'document-list__item--drop-target': dropTargetGroupId === group.id,
              }"
              @dragenter.stop.prevent="emit('group-drag-over', $event, group.id)"
              @dragover.stop.prevent="emit('group-drag-over', $event, group.id)"
              @dragleave="emit('group-drag-leave', $event, group.id)"
              @drop.stop.prevent="emit('group-drop', $event, group.id)"
            >
              <button
                type="button"
                class="document-list__select"
                :disabled="busy"
                @click="emit('toggle-group', group.id)"
              >
                <ChevronRight v-if="collapsedGroupIds.has(group.id)" :size="14" />
                <ChevronDown v-else :size="14" />
                <Folder v-if="collapsedGroupIds.has(group.id)" :size="16" />
                <FolderOpen v-else :size="16" />
                <span class="document-list__main">
                  <NTooltip trigger="hover">
                    <template #trigger
                      ><span class="document-list__title">{{
                        displayDocumentTitle(group)
                      }}</span></template
                    >
                    {{ displayDocumentTitle(group) }}
                  </NTooltip>
                  <span class="document-list__meta"
                    >{{ getGroupArticleCount(group.id) }} 个页面</span
                  >
                </span>
              </button>
              <span class="document-list__actions document-list__actions--menu">
                <span v-if="canDropArticleIntoGroup(group.id)" class="document-list__drop-hint"
                  >放入此分组</span
                >
                <DropdownMenuRoot>
                  <DropdownMenuTrigger as-child>
                    <NButton
                      class="document-list__more"
                      size="tiny"
                      quaternary
                      :aria-label="`${displayDocumentTitle(group)}更多操作`"
                      :disabled="busy"
                      @click.stop
                    >
                      <template #icon
                        ><NIcon :size="15"><Ellipsis /></NIcon
                      ></template>
                    </NButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuContent class="document-card-menu" align="end" :side-offset="5">
                      <DropdownMenuItem class="document-card-menu__item" @select="emit('create-view', group.id)"><Plus :size="14" />新建内容</DropdownMenuItem>
                      <DropdownMenuItem
                        class="document-card-menu__item"
                        @select="emit('properties', group)"
                        ><Info :size="14" />属性</DropdownMenuItem
                      >
                      <DropdownMenuItem
                        class="document-card-menu__item"
                        @select="emit('rename', group)"
                        ><Pencil :size="14" />重命名分组</DropdownMenuItem
                      >
                    </DropdownMenuContent>
                  </DropdownMenuPortal>
                </DropdownMenuRoot>
              </span>
            </div>
          </ContextMenuTrigger>
          <ContextMenuPortal>
            <ContextMenuContent class="document-card-menu" :collision-padding="8">
              <ContextMenuItem
                class="document-card-menu__item"
                @select="emit('create-view', group.id)"
                ><Plus :size="14" />新建内容</ContextMenuItem
              >
              <ContextMenuItem class="document-card-menu__item" @select="emit('properties', group)"
                ><Info :size="14" />属性</ContextMenuItem
              >
              <ContextMenuItem class="document-card-menu__item" @select="emit('rename', group)"
                ><Pencil :size="14" />重命名分组</ContextMenuItem
              >
            </ContextMenuContent>
          </ContextMenuPortal>
        </ContextMenuRoot>

        <SidebarDocumentTree
          v-if="!collapsedGroupIds.has(group.id)"
          :nodes="getGroupArticleNodes(group.id)"
          :current-document-id="activeDocumentId"
          :collapsed-document-ids="collapsedDocumentIds"
          :dragged-article-id="draggedArticleId"
          :dragged-mind-map-id="draggedMindMapId"
          :dragged-workspace-view-id="draggedWorkspaceViewId"
          :mind-map-ids="mindMapIds"
          :workspace-view-ids="workspaceViewIds"
          :workspace-view-types="workspaceViewTypes"
          :workspace-view-pinned-at="workspaceViewPinnedAt"
          :active-mind-map-id="activeMindMapId"
          :active-workspace-view-id="activeWorkspaceViewId"
          :busy="busy"
          :depth="1"
          @select="emit('select-document', $event)"
          @select-mind-map="emit('select-mind-map', $event)"
          @select-workspace-view="emit('select-workspace-view', $event)"
          @toggle="emit('toggle-document', $event)"
          @create-child-view="emit('create-view', $event)"
          @delete-mind-map="emit('delete-mind-map', $event)"
          @delete-workspace-view="emit('delete-workspace-view', $event)"
          @rename-mind-map="emit('rename-mind-map', $event)"
          @properties-mind-map="emit('properties-mind-map', $event)"
          @rename-workspace-view="emit('rename-workspace-view', $event)"
          @properties-workspace-view="emit('properties-workspace-view', $event)"
          @pin-workspace-view="emit('pin-workspace-view', $event)"
          @properties="emit('properties', $event)"
          @rename="emit('rename', $event)"
          @delete="emit('delete', $event)"
          @drag-start="emit('article-drag-start', $event.event, $event.document)"
          @mind-map-drag-start="emit('mind-map-drag-start', $event.event, $event.mindMapId)"
          @workspace-view-drag-start="emit('workspace-view-drag-start', $event.event, $event.viewId)"
          @drag-end="emit('article-drag-end')"
        />
      </div>

      <p
        v-if="articleGroups.length > 0 && ungroupedArticleNodes.length > 0"
        class="document-list__subheading"
      >
        未分组
      </p>

      <SidebarDocumentTree
        :nodes="ungroupedArticleNodes"
        :current-document-id="activeDocumentId"
        :collapsed-document-ids="collapsedDocumentIds"
        :dragged-article-id="draggedArticleId"
        :dragged-mind-map-id="draggedMindMapId"
        :dragged-workspace-view-id="draggedWorkspaceViewId"
        :mind-map-ids="mindMapIds"
        :workspace-view-ids="workspaceViewIds"
        :workspace-view-types="workspaceViewTypes"
        :workspace-view-pinned-at="workspaceViewPinnedAt"
        :active-mind-map-id="activeMindMapId"
        :active-workspace-view-id="activeWorkspaceViewId"
        :busy="busy"
        @select="emit('select-document', $event)"
        @select-mind-map="emit('select-mind-map', $event)"
        @select-workspace-view="emit('select-workspace-view', $event)"
        @toggle="emit('toggle-document', $event)"
        @create-child-view="emit('create-view', $event)"
        @delete-mind-map="emit('delete-mind-map', $event)"
        @delete-workspace-view="emit('delete-workspace-view', $event)"
        @rename-mind-map="emit('rename-mind-map', $event)"
        @properties-mind-map="emit('properties-mind-map', $event)"
        @rename-workspace-view="emit('rename-workspace-view', $event)"
        @properties-workspace-view="emit('properties-workspace-view', $event)"
        @pin-workspace-view="emit('pin-workspace-view', $event)"
        @properties="emit('properties', $event)"
        @rename="emit('rename', $event)"
        @delete="emit('delete', $event)"
        @drag-start="emit('article-drag-start', $event.event, $event.document)"
        @mind-map-drag-start="emit('mind-map-drag-start', $event.event, $event.mindMapId)"
        @workspace-view-drag-start="emit('workspace-view-drag-start', $event.event, $event.viewId)"
        @drag-end="emit('article-drag-end')"
      />

      <p
        v-if="articleGroups.length === 0 && ungroupedArticleNodes.length === 0"
        class="document-list__empty"
      >
        暂无文档
      </p>
    </div>

    <div v-if="view === 'trash'" class="document-list">
      <p class="sidebar-section-heading sidebar-section-heading--inline">回收站</p>
      <ContextMenuRoot v-for="document in deletedDocuments" :key="document.id">
        <ContextMenuTrigger as-child>
          <div class="document-list__item">
            <button
              type="button"
              class="document-list__select"
              :disabled="busy"
              @click="emit('restore', document)"
            >
              <Archive :size="16" />
              <span class="document-list__main">
                <NTooltip trigger="hover">
                  <template #trigger
                    ><span class="document-list__title">{{
                      displayDocumentTitle(document)
                    }}</span></template
                  >
                  {{ displayDocumentTitle(document) }}
                </NTooltip>
                <span class="document-list__meta"
                  >删除于 {{ formatDocumentUpdatedAt(document.updatedAt) }}</span
                >
              </span>
            </button>
            <span class="document-list__actions">
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    size="tiny"
                    quaternary
                    circle
                    aria-label="恢复"
                    :disabled="busy"
                    @click.stop="emit('restore', document)"
                  >
                    <template #icon
                      ><NIcon :size="14"><RotateCcw /></NIcon
                    ></template>
                  </NButton>
                </template>
                恢复
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    size="tiny"
                    quaternary
                    circle
                    aria-label="彻底删除"
                    :disabled="busy"
                    @click.stop="emit('permanently-delete', document)"
                  >
                    <template #icon
                      ><NIcon :size="14"><Trash2 /></NIcon
                    ></template>
                  </NButton>
                </template>
                彻底删除
              </NTooltip>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent class="document-card-menu" :collision-padding="8">
            <ContextMenuItem class="document-card-menu__item" @select="emit('restore', document)"
              ><RotateCcw :size="14" />恢复</ContextMenuItem
            >
            <ContextMenuItem
              class="document-card-menu__item document-card-menu__item--danger"
              @select="emit('permanently-delete', document)"
              ><Trash2 :size="14" />彻底删除</ContextMenuItem
            >
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenuRoot>

      <p v-if="deletedDocuments.length === 0" class="document-list__empty">回收站为空</p>
    </div>

    <div class="sidebar-footer">
      <NButton
        class="market-link"
        :class="{ 'market-link--active': view === 'trash' }"
        quaternary
        @click="toggleView"
      >
        <template #icon
          ><NIcon :size="17"><Trash2 /></NIcon
        ></template>
        回收站
      </NButton>
    </div>
  </aside>
</template>
