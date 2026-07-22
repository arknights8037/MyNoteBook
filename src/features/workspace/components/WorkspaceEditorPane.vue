<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'

import type { AppSettings } from '@/models/settings/settings'
import type { DocumentId, DocumentSummary, TiptapDocumentJson } from '@/models/documents/document'
import type { MindMapSummary } from '@/models/workspace/mindMap'
import type { StructuredWorkspaceViewSummary } from '@/models/workspace/workspaceView'
import type { MindMapService } from '@/services/workspace/MindMapService'
import type { WorkspaceViewService } from '@/services/workspace/WorkspaceViewService'
import EditorTopbar from './home/EditorTopbar.vue'
import LazySurfaceLoader from './home/LazySurfaceLoader.vue'
import type { EditorShellExpose } from './home/homePageTypes'

const EditorShell = defineAsyncComponent({
  loader: () => import('@/editor/components/EditorShell.vue'),
  loadingComponent: LazySurfaceLoader,
  delay: 80,
  suspensible: false,
})
const MindMapWorkspace = defineAsyncComponent({
  loader: () => import('@/features/mind-map/components/MindMapWorkspace.vue'),
  loadingComponent: LazySurfaceLoader,
  delay: 80,
  suspensible: false,
})
const WorkspaceViewWorkspace = defineAsyncComponent({
  loader: () => import('@/features/workspace-views/components/WorkspaceViewWorkspace.vue'),
  loadingComponent: LazySurfaceLoader,
  delay: 80,
  suspensible: false,
})

defineProps<{
  activeMindMapId: string | null
  activeWorkspaceViewId: string | null
  mindMaps: MindMapSummary[]
  workspaceViews: StructuredWorkspaceViewSummary[]
  documentTitle: string
  editorContent: TiptapDocumentJson
  editorSettings: AppSettings
  internalDocuments: Array<{ id: string; title: string; sourceUrl?: string }>
  currentDocumentId: DocumentId
  currentDocument: DocumentSummary | null
  loading: boolean
  loadError: unknown
  busy: boolean
  saveStatusClass: string
  saveStatusText: string
  preparingShare: boolean
  getMindMapService: () => Promise<MindMapService>
  getWorkspaceViewService: () => Promise<WorkspaceViewService>
}>()

const emit = defineEmits<{
  'update:title': [value: string]
  'update:editorContent': [value: TiptapDocumentJson]
  textUpdate: [value: string]
  imageError: [message: string]
  openDocument: [documentId: string]
  titleInput: []
  commitTitle: []
  createChild: []
  share: []
  insertImage: []
  insertAttachment: []
  inspect: []
  search: []
  mindMapSaved: [summary: MindMapSummary]
  workspaceViewSaved: [summary: StructuredWorkspaceViewSummary]
}>()

const editorShell = ref<EditorShellExpose | null>(null)

function insertImage(): void {
  editorShell.value?.insertImage()
  emit('insertImage')
}

function insertAttachment(): void {
  editorShell.value?.insertAttachment()
  emit('insertAttachment')
}

defineExpose<EditorShellExpose>({
  getJSON: () => editorShell.value?.getJSON(),
  getText: () => editorShell.value?.getText() ?? '',
  getDocumentMarkdown: () => editorShell.value?.getDocumentMarkdown() ?? '',
  getCurrentDocumentBlocks: () => editorShell.value?.getCurrentDocumentBlocks() ?? [],
  getSelectedBlocks: () => editorShell.value?.getSelectedBlocks() ?? [],
  hasBlockSelection: () => editorShell.value?.hasBlockSelection() ?? false,
  insertImage,
  insertAttachment,
  insertMarkdown: (markdown) => editorShell.value?.insertMarkdown(markdown),
  replaceBlocksWithMarkdown: (blockIds, markdown) =>
    editorShell.value?.replaceBlocksWithMarkdown(blockIds, markdown) ?? false,
  revealBlock: (blockId) => editorShell.value?.revealBlock(blockId) ?? false,
  undo: () => editorShell.value?.undo(),
})
</script>

<template>
  <section
    class="editor-panel"
    :class="{ 'editor-panel--behind-ai': $slots.fullscreenAi }"
    :aria-hidden="Boolean($slots.fullscreenAi)"
  >
    <slot name="fullscreenAi" />

    <MindMapWorkspace
      v-if="activeMindMapId"
      :key="`${activeMindMapId}:${mindMaps.find((item) => item.id === activeMindMapId)?.version ?? 0}`"
      :mind-map-id="activeMindMapId"
      :get-service="getMindMapService"
      @saved="emit('mindMapSaved', $event)"
    />
    <WorkspaceViewWorkspace
      v-else-if="activeWorkspaceViewId"
      :key="`${activeWorkspaceViewId}:${workspaceViews.find((item) => item.id === activeWorkspaceViewId)?.version ?? 0}`"
      :view-id="activeWorkspaceViewId"
      :get-service="getWorkspaceViewService"
      @saved="emit('workspaceViewSaved', $event)"
    />
    <template v-else>
      <EditorTopbar
        :title="documentTitle"
        :disabled="loading || Boolean(loadError)"
        :busy="busy"
        :has-document="Boolean(currentDocument)"
        :save-status-class="saveStatusClass"
        :save-status-text="saveStatusText"
        :preparing-share="preparingShare"
        @update:title="emit('update:title', $event)"
        @title-input="emit('titleInput')"
        @commit-title="emit('commitTitle')"
        @create-child="emit('createChild')"
        @share="emit('share')"
        @insert-image="insertImage"
        @insert-attachment="insertAttachment"
        @inspect="emit('inspect')"
        @search="emit('search')"
      />
      <EditorShell
        ref="editorShell"
        :model-value="editorContent"
        :readonly="loading || Boolean(loadError)"
        :settings="editorSettings"
        :internal-documents="internalDocuments"
        :document-id="currentDocumentId"
        @update:model-value="emit('update:editorContent', $event)"
        @text-update="emit('textUpdate', $event)"
        @image-error="emit('imageError', $event)"
        @open-document="emit('openDocument', $event)"
        @unresolved-document-link="emit('imageError', `未找到链接对应的知识库文档：${$event}`)"
      />
    </template>
  </section>
</template>
