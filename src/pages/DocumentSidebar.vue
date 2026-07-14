<script setup lang="ts">
import {
  Archive,
  Blocks,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Info,
  BookOpenCheck,
  ClipboardList,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  Upload,
  View,
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
} from '@/features/documents/documentPresentation'
import {
  buildSidebarDocumentForest,
  countSidebarDocumentNodes,
} from '@/features/documents/documentTree'
import type { DocumentId, DocumentSummary } from '@/models/document'
import NButton from '@/ui/NButton.vue'
import NButtonGroup from '@/ui/NButtonGroup.vue'
import NIcon from '@/ui/NIcon.vue'
import NTooltip from '@/ui/NTooltip.vue'

export type SidebarView = 'documents' | 'trash'
export type WorkspaceSurface =
  | 'agent'
  | 'document'
  | 'plugins'
  | 'automations'
  | 'audit'
  | 'knowledge'
  | 'settings'
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserDragEvent = InstanceType<typeof globalThis.DragEvent>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const props = defineProps<{
  documents: DocumentSummary[]
  deletedDocuments: DocumentSummary[]
  view: SidebarView
  activeSurface: WorkspaceSurface
  currentDocumentId: DocumentId
  selectedGroupId: DocumentId | null
  collapsedGroupIds: Set<DocumentId>
  collapsedDocumentIds: Set<DocumentId>
  draggedArticleId: DocumentId | null
  dropTargetGroupId: DocumentId | null
  importFileAccept: string
  busy: boolean
}>()

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
  'update:view': [view: SidebarView]
  'toggle-group': [groupId: DocumentId]
  'select-document': [documentId: DocumentId]
  'toggle-document': [documentId: DocumentId]
  properties: [document: DocumentSummary]
  rename: [document: DocumentSummary]
  delete: [document: DocumentSummary]
  restore: [document: DocumentSummary]
  'permanently-delete': [document: DocumentSummary]
  'article-drag-start': [event: BrowserDragEvent, document: DocumentSummary]
  'article-drag-end': []
  'group-drag-over': [event: BrowserDragEvent, groupId: DocumentId]
  'group-drag-leave': [event: BrowserDragEvent, groupId: DocumentId]
  'group-drop': [event: BrowserDragEvent, groupId: DocumentId]
}>()

const fileInput = ref<BrowserInputElement | null>(null)
const documentForest = computed(() => buildSidebarDocumentForest(props.documents))
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
      <button
        type="button"
        class="sidebar-brand__home"
        aria-label="打开 Agent Work"
        @click="emit('agent')"
      >
        <span class="sidebar-brand__mark" aria-hidden="true"><Bot :size="17" /></span>
        <strong>myNoteBook</strong>
      </button>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="sidebar-quickbar__button"
            quaternary
            circle
            aria-label="搜索"
            @click="emit('search')"
          >
            <template #icon
              ><NIcon :size="21"><Search /></NIcon
            ></template>
          </NButton>
        </template>
        搜索
      </NTooltip>
    </header>

    <nav class="sidebar-primary-nav" aria-label="工作区导航">
      <button
        type="button"
        class="sidebar-primary-nav__item"
        :class="{ 'sidebar-primary-nav__item--active': activeSurface === 'agent' }"
        @click="emit('agent')"
      >
        <Bot :size="18" /><span>Agent Work</span>
      </button>
      <button
        type="button"
        class="sidebar-primary-nav__item"
        :class="{ 'sidebar-primary-nav__item--active': activeSurface === 'knowledge' }"
        @click="emit('knowledge')"
      >
        <BookOpenCheck :size="18" /><span>知识控制</span>
      </button>
      <button type="button" class="sidebar-primary-nav__item" @click="emit('new-view')">
        <View :size="18" /><span>新建视图</span
        ><Plus class="sidebar-primary-nav__trailing" :size="15" />
      </button>
      <button
        type="button"
        class="sidebar-primary-nav__item"
        :class="{ 'sidebar-primary-nav__item--active': activeSurface === 'plugins' }"
        @click="emit('plugins')"
      >
        <Blocks :size="18" /><span>插件技能</span>
      </button>
      <button
        type="button"
        class="sidebar-primary-nav__item"
        :class="{ 'sidebar-primary-nav__item--active': activeSurface === 'automations' }"
        @click="emit('automations')"
      >
        <CalendarClock :size="18" /><span>自动化任务</span>
      </button>
      <button
        type="button"
        class="sidebar-primary-nav__item"
        :class="{ 'sidebar-primary-nav__item--active': activeSurface === 'audit' }"
        @click="emit('audit')"
      >
        <ClipboardList :size="18" /><span>审计记录</span>
      </button>
      <button
        type="button"
        class="sidebar-primary-nav__item"
        :class="{ 'sidebar-primary-nav__item--active': activeSurface === 'settings' }"
        @click="emit('settings')"
      >
        <Settings :size="18" /><span>设置</span>
      </button>
    </nav>

    <div class="sidebar-section-heading">
      <span>空间</span>
      <NButtonGroup class="sidebar-section-heading__actions">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary circle aria-label="导入" @click="emit('import')">
              <template #icon
                ><NIcon :size="14"><Upload /></NIcon
              ></template>
            </NButton>
          </template>
          导入 JSON / Markdown
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              size="tiny"
              quaternary
              circle
              aria-label="新建分组"
              :disabled="busy"
              @click="emit('create-group')"
            >
              <template #icon
                ><NIcon :size="14"><Folder /></NIcon
              ></template>
            </NButton>
          </template>
          新建分组
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              size="tiny"
              quaternary
              circle
              aria-label="新建页面"
              :disabled="busy"
              @click="emit('create-document', null)"
            >
              <template #icon
                ><NIcon :size="14"><Plus /></NIcon
              ></template>
            </NButton>
          </template>
          新建页面
        </NTooltip>
      </NButtonGroup>
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
                <NTooltip trigger="hover">
                  <template #trigger>
                    <NButton
                      class="document-list__more"
                      size="tiny"
                      quaternary
                      :aria-label="`${displayDocumentTitle(group)}中新建页面`"
                      :disabled="busy"
                      @click.stop="emit('create-document', group.id)"
                    >
                      <template #icon
                        ><NIcon :size="14"><Plus /></NIcon
                      ></template>
                    </NButton>
                  </template>
                  新建页面
                </NTooltip>
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
                @select="emit('create-document', group.id)"
                ><Plus :size="14" />新建页面</ContextMenuItem
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
          :current-document-id="currentDocumentId"
          :collapsed-document-ids="collapsedDocumentIds"
          :dragged-article-id="draggedArticleId"
          :busy="busy"
          :depth="1"
          @select="emit('select-document', $event)"
          @toggle="emit('toggle-document', $event)"
          @create-child="emit('create-document', $event)"
          @properties="emit('properties', $event)"
          @rename="emit('rename', $event)"
          @delete="emit('delete', $event)"
          @drag-start="emit('article-drag-start', $event.event, $event.document)"
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
        :current-document-id="currentDocumentId"
        :collapsed-document-ids="collapsedDocumentIds"
        :dragged-article-id="draggedArticleId"
        :busy="busy"
        @select="emit('select-document', $event)"
        @toggle="emit('toggle-document', $event)"
        @create-child="emit('create-document', $event)"
        @properties="emit('properties', $event)"
        @rename="emit('rename', $event)"
        @delete="emit('delete', $event)"
        @drag-start="emit('article-drag-start', $event.event, $event.document)"
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
