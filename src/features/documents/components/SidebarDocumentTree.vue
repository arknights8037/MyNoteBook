<script setup lang="ts">
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  GitBranch,
  Info,
  Network,
  Pencil,
  Pin,
  Plus,
  Presentation,
  Table2,
  Trash2,
} from '@lucide/vue'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui'

import type { SidebarDocumentNode } from '@/features/documents/documentTree'
import type { DocumentId, DocumentSummary } from '@/models/document'
import type { StructuredWorkspaceViewType } from '@/models/workspaceView'
import NButton from '@/ui/NButton.vue'
import NIcon from '@/ui/NIcon.vue'
import NTooltip from '@/ui/NTooltip.vue'

defineOptions({ name: 'SidebarDocumentTree' })

type BrowserDragEvent = InstanceType<typeof globalThis.DragEvent>
type ContentKind = 'document' | 'mindmap' | 'workspace-view'

const props = withDefaults(
  defineProps<{
    nodes: SidebarDocumentNode[]
    currentDocumentId: DocumentId
    collapsedDocumentIds: Set<DocumentId>
    draggedArticleId: DocumentId | null
    draggedMindMapId?: string | null
    draggedWorkspaceViewId?: string | null
    mindMapIds?: Set<string>
    workspaceViewIds?: Set<string>
    workspaceViewTypes?: Record<string, StructuredWorkspaceViewType>
    workspaceViewPinnedAt?: Record<string, number | null>
    activeMindMapId?: string | null
    activeWorkspaceViewId?: string | null
    busy: boolean
    depth?: number
  }>(),
  {
    depth: 0,
    draggedMindMapId: null,
    draggedWorkspaceViewId: null,
    mindMapIds: () => new Set<string>(),
    workspaceViewIds: () => new Set<string>(),
    workspaceViewTypes: () => ({}),
    workspaceViewPinnedAt: () => ({}),
    activeMindMapId: null,
    activeWorkspaceViewId: null,
  },
)

const emit = defineEmits<{
  select: [documentId: DocumentId]
  selectMindMap: [mindMapId: string]
  selectWorkspaceView: [viewId: string]
  toggle: [documentId: DocumentId]
  createChildView: [parentId: DocumentId]
  deleteMindMap: [mindMapId: string]
  deleteWorkspaceView: [viewId: string]
  renameMindMap: [mindMapId: string]
  propertiesMindMap: [mindMapId: string]
  renameWorkspaceView: [viewId: string]
  propertiesWorkspaceView: [viewId: string]
  pinWorkspaceView: [viewId: string]
  properties: [document: DocumentSummary]
  rename: [document: DocumentSummary]
  delete: [document: DocumentSummary]
  dragStart: [payload: { event: BrowserDragEvent; document: DocumentSummary }]
  mindMapDragStart: [payload: { event: BrowserDragEvent; mindMapId: string }]
  workspaceViewDragStart: [payload: { event: BrowserDragEvent; viewId: string }]
  dragEnd: []
}>()

function displayTitle(document: DocumentSummary): string {
  const title = document.title.trim()
  return title.length > 0 ? title : '未命名文档'
}

function contentKind(id: string): ContentKind {
  if (props.mindMapIds.has(id)) return 'mindmap'
  if (props.workspaceViewIds.has(id)) return 'workspace-view'
  return 'document'
}

function isActive(id: string): boolean {
  const kind = contentKind(id)
  if (kind === 'mindmap') return id === props.activeMindMapId
  if (kind === 'workspace-view') return id === props.activeWorkspaceViewId
  return id === props.currentDocumentId
}

function startDrag(event: BrowserDragEvent, document: DocumentSummary): void {
  const kind = contentKind(document.id)
  if (kind === 'mindmap') emit('mindMapDragStart', { event, mindMapId: document.id })
  else if (kind === 'workspace-view') emit('workspaceViewDragStart', { event, viewId: document.id })
  else emit('dragStart', { event, document })
}

function selectContent(id: string): void {
  const kind = contentKind(id)
  if (kind === 'mindmap') emit('selectMindMap', id)
  else if (kind === 'workspace-view') emit('selectWorkspaceView', id)
  else emit('select', id)
}

function viewIcon(id: string) {
  const type = props.workspaceViewTypes[id]
  if (type === 'slides') return Presentation
  if (type === 'uml') return GitBranch
  return Table2
}

function deleteContent(id: string): void {
  const kind = contentKind(id)
  if (kind === 'mindmap') emit('deleteMindMap', id)
  else if (kind === 'workspace-view') emit('deleteWorkspaceView', id)
}

function renameContent(id: string): void {
  const kind = contentKind(id)
  if (kind === 'mindmap') emit('renameMindMap', id)
  else if (kind === 'workspace-view') emit('renameWorkspaceView', id)
}

function showContentProperties(id: string): void {
  const kind = contentKind(id)
  if (kind === 'mindmap') emit('propertiesMindMap', id)
  else if (kind === 'workspace-view') emit('propertiesWorkspaceView', id)
}
</script>

<template>
  <template v-for="node in nodes" :key="node.document.id">
    <ContextMenuRoot>
      <ContextMenuTrigger as-child>
        <div
          class="document-list__item document-list__item--article document-list__item--tree"
          :class="{
            'document-list__item--mindmap': contentKind(node.document.id) === 'mindmap',
            'document-list__item--workspace-view': contentKind(node.document.id) === 'workspace-view',
            'document-list__item--active': isActive(node.document.id),
            'document-list__item--dragging':
              node.document.id === draggedArticleId ||
              node.document.id === draggedMindMapId ||
              node.document.id === draggedWorkspaceViewId,
          }"
          :style="{ '--document-tree-depth': depth }"
          draggable="true"
          @dragstart="startDrag($event, node.document)"
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

          <button type="button" class="document-list__select" :disabled="busy" @click="selectContent(node.document.id)">
            <Network v-if="contentKind(node.document.id) === 'mindmap'" :size="16" />
            <component :is="viewIcon(node.document.id)" v-else-if="contentKind(node.document.id) === 'workspace-view'" :size="16" />
            <FileText v-else :size="16" />
            <span class="document-list__main">
              <NTooltip trigger="hover"><template #trigger><span class="document-list__title">{{ displayTitle(node.document) }}</span></template>{{ displayTitle(node.document) }}</NTooltip>
              <span v-if="contentKind(node.document.id) !== 'document' || node.children.length > 0" class="document-list__meta">
                {{ contentKind(node.document.id) === 'document' ? `${node.children.length} 个子页面` : node.document.description }}
              </span>
            </span>
          </button>

          <span class="document-list__actions document-list__actions--menu">
            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <NButton class="document-list__more" size="tiny" quaternary :aria-label="`${displayTitle(node.document)}更多操作`" :disabled="busy" @click.stop @dragstart.stop.prevent>
                  <template #icon><NIcon :size="15"><Ellipsis /></NIcon></template>
                </NButton>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="document-card-menu" align="end" :side-offset="5">
                  <DropdownMenuItem class="document-card-menu__item" @select="emit('createChildView', node.document.id)"><Plus :size="14" />新建内容</DropdownMenuItem>
                  <template v-if="contentKind(node.document.id) === 'document'">
                    <DropdownMenuItem class="document-card-menu__item" @select="emit('properties', node.document)"><Info :size="14" />属性</DropdownMenuItem>
                    <DropdownMenuItem class="document-card-menu__item" @select="emit('rename', node.document)"><Pencil :size="14" />重命名</DropdownMenuItem>
                    <DropdownMenuSeparator class="document-card-menu__separator" />
                    <DropdownMenuItem class="document-card-menu__item document-card-menu__item--danger" @select="emit('delete', node.document)"><Trash2 :size="14" />删除</DropdownMenuItem>
                  </template>
                  <template v-else>
                    <DropdownMenuItem v-if="contentKind(node.document.id) === 'workspace-view'" class="document-card-menu__item" @select="emit('pinWorkspaceView', node.document.id)"><Pin :size="14" />{{ workspaceViewPinnedAt[node.document.id] !== null && workspaceViewPinnedAt[node.document.id] !== undefined ? '取消置顶' : '置顶' }}</DropdownMenuItem>
                    <DropdownMenuItem class="document-card-menu__item" @select="showContentProperties(node.document.id)"><Info :size="14" />属性</DropdownMenuItem>
                    <DropdownMenuItem class="document-card-menu__item" @select="renameContent(node.document.id)"><Pencil :size="14" />重命名</DropdownMenuItem>
                    <DropdownMenuSeparator class="document-card-menu__separator" />
                    <DropdownMenuItem class="document-card-menu__item document-card-menu__item--danger" @select="deleteContent(node.document.id)"><Trash2 :size="14" />删除{{ contentKind(node.document.id) === 'mindmap' ? '思维导图' : '视图' }}</DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="document-card-menu" :collision-padding="8">
          <ContextMenuItem class="document-card-menu__item" @select="emit('createChildView', node.document.id)"><Plus :size="14" />新建内容</ContextMenuItem>
          <template v-if="contentKind(node.document.id) === 'document'">
            <ContextMenuItem class="document-card-menu__item" @select="emit('properties', node.document)"><Info :size="14" />属性</ContextMenuItem>
            <ContextMenuItem class="document-card-menu__item" @select="emit('rename', node.document)"><Pencil :size="14" />重命名</ContextMenuItem>
            <ContextMenuSeparator class="document-card-menu__separator" />
            <ContextMenuItem class="document-card-menu__item document-card-menu__item--danger" @select="emit('delete', node.document)"><Trash2 :size="14" />删除</ContextMenuItem>
          </template>
          <template v-else>
            <ContextMenuItem v-if="contentKind(node.document.id) === 'workspace-view'" class="document-card-menu__item" @select="emit('pinWorkspaceView', node.document.id)"><Pin :size="14" />{{ workspaceViewPinnedAt[node.document.id] !== null && workspaceViewPinnedAt[node.document.id] !== undefined ? '取消置顶' : '置顶' }}</ContextMenuItem>
            <ContextMenuItem class="document-card-menu__item" @select="showContentProperties(node.document.id)"><Info :size="14" />属性</ContextMenuItem>
            <ContextMenuItem class="document-card-menu__item" @select="renameContent(node.document.id)"><Pencil :size="14" />重命名</ContextMenuItem>
            <ContextMenuSeparator class="document-card-menu__separator" />
            <ContextMenuItem class="document-card-menu__item document-card-menu__item--danger" @select="deleteContent(node.document.id)"><Trash2 :size="14" />删除{{ contentKind(node.document.id) === 'mindmap' ? '思维导图' : '视图' }}</ContextMenuItem>
          </template>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenuRoot>

    <SidebarDocumentTree
      v-if="node.children.length > 0 && !collapsedDocumentIds.has(node.document.id)"
      :nodes="node.children"
      :current-document-id="currentDocumentId"
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
      :depth="depth + 1"
      @select="emit('select', $event)"
      @select-mind-map="emit('selectMindMap', $event)"
      @select-workspace-view="emit('selectWorkspaceView', $event)"
      @toggle="emit('toggle', $event)"
      @create-child-view="emit('createChildView', $event)"
      @delete-mind-map="emit('deleteMindMap', $event)"
      @delete-workspace-view="emit('deleteWorkspaceView', $event)"
      @rename-mind-map="emit('renameMindMap', $event)"
      @properties-mind-map="emit('propertiesMindMap', $event)"
      @rename-workspace-view="emit('renameWorkspaceView', $event)"
      @properties-workspace-view="emit('propertiesWorkspaceView', $event)"
      @pin-workspace-view="emit('pinWorkspaceView', $event)"
      @properties="emit('properties', $event)"
      @rename="emit('rename', $event)"
      @delete="emit('delete', $event)"
      @drag-start="emit('dragStart', $event)"
      @mind-map-drag-start="emit('mindMapDragStart', $event)"
      @workspace-view-drag-start="emit('workspaceViewDragStart', $event)"
      @drag-end="emit('dragEnd')"
    />
  </template>
</template>
