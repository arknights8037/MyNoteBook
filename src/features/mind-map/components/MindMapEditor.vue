<script setup lang="ts">
import {
  CornerDownRight,
  Focus,
  Pencil,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue'
import MindElixir, { type MindElixirInstance, type Topic } from 'mind-elixir'
import 'mind-elixir/style.css'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'reka-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { MindMapContent } from '@/models/workspace/mindMap'
import { createEntityId } from '@/models/shared/id'
import { fromMindElixirData, toMindElixirData } from '@/features/mind-map/mindElixirAdapter'

const props = defineProps<{
  content: MindMapContent
  readonly?: boolean
}>()
const emit = defineEmits<{
  change: [content: MindMapContent]
  export: []
  inspect: []
}>()

const container = ref<MindElixirInstance['el'] | null>(null)
let mind: MindElixirInstance | null = null
let applyingExternalValue = false
let operationHandler: ((operation: { name: string }) => void) | null = null
let expandHandler: (() => void) | null = null
let directionHandler: (() => void) | null = null
let selectionHandler: (() => void) | null = null
let lastEmittedContent: MindMapContent | null = null
let editingNodeId: string | null = null
let pendingExternalContent: MindMapContent | null = null
const selectedNodeId = ref<string | null>(null)
const rootSelected = computed(() => selectedNodeId.value === props.content.rootNodeId)
const contextNodeId = ref<string | null>(null)
let panPointerId: number | null = null
let panX = 0
let panY = 0

function selectedNode() {
  if (!mind) return null
  return mind.currentNode ?? mind.findEle(props.content.rootNodeId)
}

function syncSelection(): void {
  selectedNodeId.value = mind?.currentNode?.nodeObj.id ?? null
}

async function focusEditorInput(): Promise<InstanceType<typeof globalThis.HTMLElement> | null> {
  // MindElixir creates the contenteditable overlay during beginEdit. Wait for the DOM
  // insertion so the shell's canvas gesture handling never gets a chance to steal focus.
  await nextTick()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const input = mind?.nodes.querySelector<InstanceType<typeof globalThis.HTMLElement>>('#input-box')
    if (input) {
      input.tabIndex = 0
      input.focus({ preventScroll: true })
      return input
    }
    await new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve()))
  }
  return null
}

async function startEditing(target: Topic): Promise<void> {
  if (!mind || props.readonly) return
  mind.selectNode(target)
  syncSelection()
  editingNodeId = target.nodeObj.id
  await mind.beginEdit(target)
  const input = await focusEditorInput()
  if (!input) {
    editingNodeId = null
    return
  }
  input.addEventListener('blur', finishEditingSession, { once: true })
}

async function addChild(): Promise<void> {
  const parentId = selectedNodeId.value
  if (!parentId || props.readonly) return
  const id = createNodeId()
  const siblings = Object.values(props.content.nodes).filter((node) => node.parentId === parentId)
  await commitDirect(
    {
      ...props.content,
      nodes: {
        ...props.content.nodes,
        [id]: createNode(
          id,
          parentId,
          siblings.length,
          resolveBranchDirection(props.content, parentId),
        ),
      },
    },
    id,
    true,
  )
}

async function addRootBranch(direction: 'left' | 'right'): Promise<void> {
  if (!mind || props.readonly) return
  const id = createNodeId()
  const siblings = Object.values(props.content.nodes).filter(
    (node) => node.parentId === props.content.rootNodeId,
  )
  await commitDirect(
    {
      ...props.content,
      nodes: {
        ...props.content.nodes,
        [id]: {
          ...createNode(id, props.content.rootNodeId, siblings.length),
          branchDirection: direction,
        },
      },
    },
    id,
    true,
  )
}

async function addSibling(): Promise<void> {
  const targetId = selectedNodeId.value
  const target = targetId ? props.content.nodes[targetId] : null
  if (!target || !target.parentId || props.readonly) return
  const id = createNodeId()
  const siblings = Object.values(props.content.nodes).filter(
    (node) => node.parentId === target.parentId,
  )
  const nodes = Object.fromEntries(
    Object.entries(props.content.nodes).map(([nodeId, node]) => [
      nodeId,
      node.parentId === target.parentId && node.order > target.order
        ? { ...node, order: node.order + 1 }
        : node,
    ]),
  )
  nodes[id] = createNode(
    id,
    target.parentId,
    Math.min(target.order + 1, siblings.length),
    resolveBranchDirection(props.content, targetId),
  )
  await commitDirect({ ...props.content, nodes }, id, true)
}

async function editNode(): Promise<void> {
  const target = selectedNode()
  if (!mind || !target || props.readonly) return
  await startEditing(target)
}

async function removeNode(): Promise<void> {
  const targetId = selectedNodeId.value
  if (!targetId || targetId === props.content.rootNodeId || props.readonly) return
  const removed = new Set<string>([targetId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of Object.values(props.content.nodes)) {
      if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
        removed.add(node.id)
        changed = true
      }
    }
  }
  const nodes = Object.fromEntries(
    Object.entries(props.content.nodes).filter(([id]) => !removed.has(id)),
  )
  await commitDirect(
    {
      ...props.content,
      nodes,
      links: props.content.links.filter(
        (link) => !removed.has(link.fromNodeId) && !removed.has(link.toNodeId),
      ),
    },
    props.content.nodes[targetId]?.parentId ?? props.content.rootNodeId,
    false,
  )
}

function createNodeId(): string {
  return createEntityId('mindmap-node')
}

function createNode(
  id: string,
  parentId: string,
  order: number,
  branchDirection?: 'left' | 'right',
) {
  return {
    id,
    parentId,
    order,
    text: '新节点',
    note: '',
    collapsed: false,
    ...(branchDirection ? { branchDirection } : {}),
    sourceRefs: [],
    metadata: {},
    style: {},
  }
}

function resolveBranchDirection(
  content: MindMapContent,
  nodeId: string,
): 'left' | 'right' | undefined {
  const visited = new Set<string>()
  let current = content.nodes[nodeId]
  while (current && current.id !== content.rootNodeId && !visited.has(current.id)) {
    if (current.branchDirection) return current.branchDirection
    visited.add(current.id)
    current = current.parentId ? content.nodes[current.parentId] : undefined
  }
  return undefined
}

async function commitDirect(
  content: MindMapContent,
  nodeId: string,
  edit: boolean,
): Promise<void> {
  if (!mind) return
  lastEmittedContent = content
  emit('change', content)
  await applyContent(content)
  const topic = mind.findEle(nodeId)
  if (!topic) return
  mind.selectNode(topic, true)
  syncSelection()
  if (edit) await startEditing(topic)
}

function zoom(delta: number): void {
  if (!mind) return
  mind.scale(mind.scaleVal + delta)
}

function fitView(): void {
  mind?.scaleFit()
}

function topicFromTarget(
  target: InstanceType<typeof globalThis.EventTarget> | null,
): Topic | null {
  return target instanceof globalThis.Element ? (target.closest('me-tpc') as Topic | null) : null
}

function handlePointerDown(event: InstanceType<typeof globalThis.PointerEvent>): void {
  const target = event.target
  // The edit overlay is a sibling of <me-tpc>, so it looks like blank canvas to the
  // custom pan handler. Let it receive its native pointer/focus events untouched.
  if (target instanceof globalThis.Element && target.closest('#input-box')) return
  const topic = topicFromTarget(event.target)
  if (topic && mind) {
    mind.selectNode(topic)
    syncSelection()
    return
  }
  if (
    event.button !== 0 ||
    !(target instanceof globalThis.Element) ||
    target.closest('.mind-map-node-toolbar') ||
    !target.closest('.mind-map-editor')
  ) {
    return
  }
  panPointerId = event.pointerId
  panX = event.clientX
  panY = event.clientY
  const shell = event.currentTarget
  if (
    shell instanceof globalThis.HTMLElement &&
    typeof shell.setPointerCapture === 'function'
  ) {
    shell.setPointerCapture(event.pointerId)
  }
}

function handleDoubleClick(event: InstanceType<typeof globalThis.MouseEvent>): void {
  if (event.target instanceof globalThis.Element && event.target.closest('#input-box')) return
  const topic = topicFromTarget(event.target)
  if (!topic || !mind || props.readonly) return
  event.preventDefault()
  event.stopPropagation()
  void startEditing(topic)
}

function handleContextMenu(event: InstanceType<typeof globalThis.MouseEvent>): void {
  const target = event.target
  if (
    !(target instanceof globalThis.Element) ||
    target.closest('#input-box') ||
    target.closest('.mind-map-node-toolbar') ||
    !target.closest('.mind-map-editor')
  ) {
    return
  }
  const topic = topicFromTarget(target)
  if (topic && mind) {
    mind.selectNode(topic)
    syncSelection()
  }
  contextNodeId.value = topic?.nodeObj.id ?? null
}

function runContextAction(action: () => void | Promise<void>): void {
  void action()
}

function handlePointerMove(event: InstanceType<typeof globalThis.PointerEvent>): void {
  if (panPointerId !== event.pointerId || !mind) return
  const dx = event.clientX - panX
  const dy = event.clientY - panY
  panX = event.clientX
  panY = event.clientY
  mind.move(dx, dy)
  event.preventDefault()
  event.stopPropagation()
}

function handlePointerUp(event: InstanceType<typeof globalThis.PointerEvent>): void {
  if (panPointerId !== event.pointerId) return
  const shell = event.currentTarget
  if (
    shell instanceof globalThis.HTMLElement &&
    typeof shell.hasPointerCapture === 'function' &&
    typeof shell.releasePointerCapture === 'function' &&
    shell.hasPointerCapture(event.pointerId)
  ) {
    shell.releasePointerCapture(event.pointerId)
  }
  panPointerId = null
  event.preventDefault()
  event.stopPropagation()
}

function emitCurrentValue(): void {
  if (!mind || applyingExternalValue) return
  lastEmittedContent = fromMindElixirData(mind.getData())
  emit('change', lastEmittedContent)
}

function handleOperation(operation: { name: string }): void {
  if (operation.name === 'beginEdit') return
  if (editingNodeId && operation.name !== 'finishEdit') return
  if (operation.name === 'finishEdit') {
    editingNodeId = null
    pendingExternalContent = null
  }
  emitCurrentValue()
}

function finishEditingSession(): void {
  editingNodeId = null
  const pending = pendingExternalContent
  pendingExternalContent = null
  if (pending) void applyContent(pending)
}

async function applyContent(content: MindMapContent): Promise<void> {
  if (!mind) return
  applyingExternalValue = true
  mind.refresh(toMindElixirData(content))
  await nextTick()
  applyingExternalValue = false
}

onMounted(() => {
  if (!container.value) return
  mind = new MindElixir({
    el: container.value,
    direction: 2,
    editable: !props.readonly,
    contextMenu: false,
    toolBar: false,
    keypress: true,
    allowUndo: true,
    overflowHidden: true,
    newTopicName: '新节点',
  }) as MindElixirInstance
  mind.init(toMindElixirData(props.content))
  operationHandler = handleOperation
  expandHandler = emitCurrentValue
  directionHandler = emitCurrentValue
  selectionHandler = syncSelection
  mind.bus.addListener('operation', operationHandler)
  mind.bus.addListener('expandNode', expandHandler)
  mind.bus.addListener('changeDirection', directionHandler)
  mind.bus.addListener('selectNodes', selectionHandler)
  globalThis.requestAnimationFrame(() => {
    if (!mind) return
    const root = mind.findEle(props.content.rootNodeId)
    if (root) mind.selectNode(root)
    syncSelection()
    mind.scaleFit()
  })
})

watch(
  () => props.readonly,
  (readonly) => {
    if (!mind) return
    if (readonly) mind.disableEdit()
    else mind.enableEdit()
  },
)

watch(
  () => props.content,
  (content) => {
    if (content === lastEmittedContent) {
      lastEmittedContent = null
      return
    }
    if (editingNodeId || mind?.nodes.querySelector('#input-box')) {
      pendingExternalContent = content
      return
    }
    void applyContent(content)
  },
)

onBeforeUnmount(() => {
  if (mind && operationHandler) mind.bus.removeListener('operation', operationHandler)
  if (mind && expandHandler) mind.bus.removeListener('expandNode', expandHandler)
  if (mind && directionHandler) mind.bus.removeListener('changeDirection', directionHandler)
  if (mind && selectionHandler) mind.bus.removeListener('selectNodes', selectionHandler)
  mind?.destroy()
  mind = null
})
</script>

<template>
  <ContextMenuRoot :modal="false">
    <ContextMenuTrigger as-child>
      <div
        class="mind-map-editor-shell"
        @pointerdown.capture="handlePointerDown"
        @pointermove.capture="handlePointerMove"
        @pointerup.capture="handlePointerUp"
        @pointercancel.capture="handlePointerUp"
        @dblclick.capture="handleDoubleClick"
        @contextmenu.capture="handleContextMenu"
      >
    <div class="mind-map-node-toolbar" aria-label="思维导图节点工具栏">
      <button
        v-if="!rootSelected"
        type="button"
        :disabled="readonly || !selectedNodeId"
        title="沿当前分支添加子节点（Tab）"
        @click="addChild"
      >
        <Plus :size="15" />子节点
      </button>
      <button
        v-if="rootSelected"
        type="button"
        :disabled="readonly"
        title="在中心主题左侧添加分支"
        @click="addRootBranch('left')"
      >
        <Plus :size="15" />左分支
      </button>
      <button
        v-if="rootSelected"
        type="button"
        :disabled="readonly"
        title="在中心主题右侧添加分支"
        @click="addRootBranch('right')"
      >
        <Plus :size="15" />右分支
      </button>
      <button
        type="button"
        :disabled="readonly || rootSelected || !selectedNodeId"
        title="在当前节点后添加同级节点（Enter）"
        @click="addSibling"
      >
        <CornerDownRight :size="15" />同级节点
      </button>
      <button type="button" :disabled="readonly || !selectedNodeId" title="编辑当前节点（双击节点）" @click="editNode">
        <Pencil :size="14" />编辑
      </button>
      <button
        type="button"
        class="mind-map-node-toolbar__danger"
        :disabled="readonly || rootSelected || !selectedNodeId"
        title="删除当前节点及其子节点（Delete）"
        @click="removeNode"
      >
        <Trash2 :size="14" />删除
      </button>
      <span class="mind-map-node-toolbar__divider" aria-hidden="true"></span>
      <button type="button" title="缩小" aria-label="缩小思维导图" @click="zoom(-0.1)"><ZoomOut :size="15" /></button>
      <button type="button" title="放大" aria-label="放大思维导图" @click="zoom(0.1)"><ZoomIn :size="15" /></button>
      <button type="button" title="适应画布" @click="fitView"><Focus :size="15" />适应</button>
    </div>
    <p class="mind-map-editor-hint">
      {{ selectedNodeId ? '已选中节点' : '先点击一个节点' }} · 拖动空白处移动画布 · Tab 子节点 · Enter 同级节点
    </p>
        <div ref="container" class="mind-map-editor" aria-label="思维导图编辑器" />
      </div>
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent class="document-card-menu" :collision-padding="8">
        <template v-if="contextNodeId">
          <ContextMenuItem class="document-card-menu__item" @select="runContextAction(editNode)">编辑节点</ContextMenuItem>
          <template v-if="contextNodeId === content.rootNodeId">
            <ContextMenuItem class="document-card-menu__item" @select="runContextAction(() => addRootBranch('left'))">向左添加分支</ContextMenuItem>
            <ContextMenuItem class="document-card-menu__item" @select="runContextAction(() => addRootBranch('right'))">向右添加分支</ContextMenuItem>
          </template>
          <template v-else>
            <ContextMenuItem class="document-card-menu__item" @select="runContextAction(addChild)">添加子节点</ContextMenuItem>
            <ContextMenuItem class="document-card-menu__item" @select="runContextAction(addSibling)">添加同级节点</ContextMenuItem>
            <ContextMenuSeparator class="document-card-menu__separator" />
            <ContextMenuItem class="document-card-menu__item document-card-menu__item--danger" @select="runContextAction(removeNode)">删除节点</ContextMenuItem>
          </template>
        </template>
        <template v-else>
          <ContextMenuItem class="document-card-menu__item" @select="runContextAction(() => addRootBranch('left'))">向左添加主分支</ContextMenuItem>
          <ContextMenuItem class="document-card-menu__item" @select="runContextAction(() => addRootBranch('right'))">向右添加主分支</ContextMenuItem>
          <ContextMenuSeparator class="document-card-menu__separator" />
          <ContextMenuItem class="document-card-menu__item" @select="runContextAction(fitView)">适应画布</ContextMenuItem>
          <ContextMenuItem class="document-card-menu__item" @select="runContextAction(() => emit('export'))">导出思维导图</ContextMenuItem>
          <ContextMenuItem class="document-card-menu__item" @select="runContextAction(() => emit('inspect'))">打开开发面板</ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
