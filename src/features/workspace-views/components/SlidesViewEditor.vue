<script setup lang="ts">
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Maximize2,
  Play,
  Plus,
  Trash2,
  Type,
  X,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import type { SlidesViewPayload } from '@/models/workspace/workspaceView'
import {
  SLIDEV_CANVAS_HEIGHT,
  SLIDEV_CANVAS_WIDTH,
  addSlidevTextBox,
  duplicateSlidevPage,
  insertSlidevPage,
  moveSlidevPage,
  parseSlidevDeck,
  removeSlidevPage,
  updateSlidevPage,
  validateSlidevSource,
  type SlidevTextBox,
  type SlidevTextBoxPosition,
} from '@/models/workspace/slidevDeck'
import { renderAiMarkdown } from '@/services/ai/AiMarkdownRenderer'

type BrowserDOMRect = InstanceType<typeof globalThis.DOMRect>
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>
type BrowserHTMLInputElement = InstanceType<typeof globalThis.HTMLInputElement>
type BrowserHTMLTextAreaElement = InstanceType<typeof globalThis.HTMLTextAreaElement>
type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>
type BrowserPointerEvent = InstanceType<typeof globalThis.PointerEvent>

const props = defineProps<{ payload: SlidesViewPayload }>()
const emit = defineEmits<{ update: [payload: SlidesViewPayload] }>()

const selectedPageId = ref('')
const sourceMode = ref(false)
const sourceDraft = ref(props.payload.source)
const sourceError = ref('')
const editing = ref<{ kind: 'title' | 'body' | 'textbox'; id?: string } | null>(null)
const editingDraft = ref('')
type EditControl = BrowserHTMLInputElement | BrowserHTMLTextAreaElement
const editControl = ref<EditControl | EditControl[] | null>(null)
const canvas = ref<BrowserHTMLElement | null>(null)
const boxOverrides = reactive<Record<string, SlidevTextBoxPosition>>({})
const isPresenting = ref(false)
const presentationIndex = ref(0)
let gesture: {
  box: SlidevTextBox
  mode: 'move' | 'resize'
  startX: number
  startY: number
  origin: SlidevTextBoxPosition
  rect: BrowserDOMRect
} | null = null

const pages = computed(() => {
  try {
    return parseSlidevDeck(props.payload.source)
  } catch {
    return []
  }
})
const currentPage = computed(
  () => pages.value.find((page) => page.id === selectedPageId.value) ?? pages.value[0] ?? null,
)
const currentIndex = computed(() =>
  currentPage.value ? pages.value.findIndex((page) => page.id === currentPage.value?.id) : 0,
)
const currentBodyHtml = computed(() => renderAiMarkdown(currentPage.value?.body ?? ''))
const presentationPage = computed(() => pages.value[presentationIndex.value] ?? pages.value[0] ?? null)
const presentationBodyHtml = computed(() => renderAiMarkdown(presentationPage.value?.body ?? ''))

watch(
  pages,
  (next) => {
    if (!next.some((page) => page.id === selectedPageId.value)) selectedPageId.value = next[0]?.id ?? ''
  },
  { immediate: true },
)
watch(
  () => props.payload.source,
  (source) => {
    if (!sourceMode.value) sourceDraft.value = source
  },
)

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

function updateSource(source: string): void {
  emit('update', { ...props.payload, source })
}

function selectPage(pageId: string): void {
  commitEdit()
  selectedPageId.value = pageId
}

function addPage(): void {
  const result = insertSlidevPage(props.payload.source, currentPage.value?.id ?? null, createId)
  updateSource(result.source)
  selectedPageId.value = result.pageId
}

function duplicatePage(): void {
  if (!currentPage.value) return
  const result = duplicateSlidevPage(props.payload.source, currentPage.value.id, createId)
  updateSource(result.source)
  selectedPageId.value = result.pageId
}

function removePage(): void {
  if (!currentPage.value || pages.value.length <= 1) return
  const index = currentIndex.value
  updateSource(removeSlidevPage(props.payload.source, currentPage.value.id))
  selectedPageId.value = pages.value[index + 1]?.id ?? pages.value[index - 1]?.id ?? ''
}

function movePage(offset: -1 | 1): void {
  if (!currentPage.value) return
  updateSource(moveSlidevPage(props.payload.source, currentPage.value.id, offset))
}

function addTextBox(): void {
  if (!currentPage.value) return
  const result = addSlidevTextBox(props.payload.source, currentPage.value.id, createId)
  updateSource(result.source)
  void nextTick(() => beginEdit('textbox', result.textBoxId))
}

function removeTextBox(boxId: string): void {
  const page = currentPage.value
  if (!page) return
  updateSource(
    updateSlidevPage(props.payload.source, page.id, {
      textBoxes: page.textBoxes.filter((box) => box.id !== boxId),
    }),
  )
}

function beginEdit(kind: 'title' | 'body' | 'textbox', id?: string): void {
  const page = currentPage.value
  if (!page) return
  editing.value = { kind, id }
  editingDraft.value =
    kind === 'title'
      ? page.title
      : kind === 'body'
        ? page.body
        : page.textBoxes.find((box) => box.id === id)?.markdown ?? ''
  void nextTick(() => {
    const control = Array.isArray(editControl.value) ? editControl.value[0] : editControl.value
    control?.focus()
    control?.select()
  })
}

function commitEdit(): void {
  const active = editing.value
  const page = currentPage.value
  if (!active || !page) return
  if (active.kind === 'title') {
    updateSource(updateSlidevPage(props.payload.source, page.id, { title: editingDraft.value }))
  } else if (active.kind === 'body') {
    updateSource(updateSlidevPage(props.payload.source, page.id, { body: editingDraft.value }))
  } else if (active.id) {
    updateSource(
      updateSlidevPage(props.payload.source, page.id, {
        textBoxes: page.textBoxes.map((box) =>
          box.id === active.id ? { ...box, markdown: editingDraft.value } : box,
        ),
      }),
    )
  }
  editing.value = null
}

function cancelEdit(): void {
  editing.value = null
}

function updateNotes(value: string): void {
  if (!currentPage.value) return
  updateSource(updateSlidevPage(props.payload.source, currentPage.value.id, { notes: value }))
}

function handleNotesChange(event: BrowserEvent): void {
  updateNotes((event.target as BrowserHTMLTextAreaElement | null)?.value ?? '')
}

function toggleSourceMode(): void {
  if (sourceMode.value) {
    applySourceDraft()
    if (sourceError.value) return
  } else {
    sourceDraft.value = props.payload.source
  }
  sourceMode.value = !sourceMode.value
}

function applySourceDraft(): void {
  const invalid = validateSlidevSource(sourceDraft.value)
  if (invalid) {
    sourceError.value = invalid
    return
  }
  sourceError.value = ''
  updateSource(sourceDraft.value)
}

function boxPosition(box: SlidevTextBox): SlidevTextBoxPosition {
  return boxOverrides[box.id] ?? box.position
}

function boxStyle(box: SlidevTextBox): Record<string, string> {
  const position = boxPosition(box)
  return {
    left: `${(position.left / SLIDEV_CANVAS_WIDTH) * 100}%`,
    top: `${(position.top / SLIDEV_CANVAS_HEIGHT) * 100}%`,
    width: `${(position.width / SLIDEV_CANVAS_WIDTH) * 100}%`,
    height: `${(position.height / SLIDEV_CANVAS_HEIGHT) * 100}%`,
    transform: `rotate(${position.rotate}deg)`,
  }
}

function startBoxGesture(event: BrowserPointerEvent, box: SlidevTextBox, mode: 'move' | 'resize'): void {
  if (event.button !== 0 || !canvas.value) return
  event.preventDefault()
  event.stopPropagation()
  gesture = {
    box,
    mode,
    startX: event.clientX,
    startY: event.clientY,
    origin: { ...boxPosition(box) },
    rect: canvas.value.getBoundingClientRect(),
  }
  globalThis.window.addEventListener('pointermove', moveBoxGesture)
  globalThis.window.addEventListener('pointerup', finishBoxGesture, { once: true })
}

function moveBoxGesture(event: BrowserPointerEvent): void {
  if (!gesture) return
  const dx = ((event.clientX - gesture.startX) / gesture.rect.width) * SLIDEV_CANVAS_WIDTH
  const dy = ((event.clientY - gesture.startY) / gesture.rect.height) * SLIDEV_CANVAS_HEIGHT
  const origin = gesture.origin
  boxOverrides[gesture.box.id] = gesture.mode === 'move'
    ? {
        ...origin,
        left: clamp(origin.left + dx, 0, SLIDEV_CANVAS_WIDTH - origin.width),
        top: clamp(origin.top + dy, 0, SLIDEV_CANVAS_HEIGHT - origin.height),
      }
    : {
        ...origin,
        width: clamp(origin.width + dx, 80, SLIDEV_CANVAS_WIDTH - origin.left),
        height: clamp(origin.height + dy, 48, SLIDEV_CANVAS_HEIGHT - origin.top),
      }
}

function finishBoxGesture(): void {
  const active = gesture
  gesture = null
  globalThis.window.removeEventListener('pointermove', moveBoxGesture)
  if (!active || !currentPage.value) return
  const position = boxOverrides[active.box.id]
  if (!position) return
  updateSource(
    updateSlidevPage(props.payload.source, currentPage.value.id, {
      textBoxes: currentPage.value.textBoxes.map((box) =>
        box.id === active.box.id ? { ...box, position } : box,
      ),
    }),
  )
  delete boxOverrides[active.box.id]
}

function startPresentation(): void {
  presentationIndex.value = Math.max(0, currentIndex.value)
  isPresenting.value = true
}

function closePresentation(): void {
  isPresenting.value = false
  if (globalThis.document.fullscreenElement) void globalThis.document.exitFullscreen()
}

function changePresentationPage(offset: -1 | 1): void {
  presentationIndex.value = clamp(presentationIndex.value + offset, 0, pages.value.length - 1)
}

function handlePresentationKeys(event: BrowserKeyboardEvent): void {
  if (!isPresenting.value) return
  if (event.key === 'Escape') closePresentation()
  if (['ArrowRight', 'ArrowDown', ' '].includes(event.key)) changePresentationPage(1)
  if (['ArrowLeft', 'ArrowUp'].includes(event.key)) changePresentationPage(-1)
}

function requestPresentationFullscreen(event: BrowserEvent): void {
  const element = (event.currentTarget as BrowserHTMLElement | null)?.closest('.slidev-presentation')
  if (element?.requestFullscreen) void element.requestFullscreen()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

onMounted(() => globalThis.window.addEventListener('keydown', handlePresentationKeys))
onBeforeUnmount(() => {
  globalThis.window.removeEventListener('keydown', handlePresentationKeys)
  globalThis.window.removeEventListener('pointermove', moveBoxGesture)
})
</script>

<template>
  <div class="slides-view-editor slidev-editor">
    <aside class="slidev-editor__sidebar">
      <div class="slidev-editor__sidebar-heading">
        <strong>{{ pages.length }} 页</strong>
        <button type="button" aria-label="新增幻灯片" @click="addPage"><Plus :size="15" /></button>
      </div>
      <button
        v-for="(page, index) in pages"
        :key="page.id"
        type="button"
        class="slidev-editor__page"
        :class="{ 'slidev-editor__page--active': page.id === currentPage?.id }"
        @click="selectPage(page.id)"
      >
        <span>{{ index + 1 }}</span>
        <span class="slidev-editor__thumbnail"><strong>{{ page.title }}</strong><small>{{ page.body || '空白页面' }}</small></span>
      </button>
    </aside>

    <main class="slidev-editor__workspace">
      <div class="slidev-editor__toolbar">
        <button type="button" title="新增页面" @click="addPage"><Plus :size="16" />新增</button>
        <button type="button" title="复制当前页面" :disabled="!currentPage" @click="duplicatePage"><Copy :size="16" />复制</button>
        <button type="button" title="上移页面" :disabled="currentIndex <= 0" @click="movePage(-1)"><ChevronUp :size="16" /></button>
        <button type="button" title="下移页面" :disabled="currentIndex >= pages.length - 1" @click="movePage(1)"><ChevronDown :size="16" /></button>
        <button type="button" title="删除页面" :disabled="pages.length <= 1" @click="removePage"><Trash2 :size="16" /></button>
        <span class="slidev-editor__toolbar-separator"></span>
        <button type="button" :disabled="!currentPage" @click="addTextBox"><Type :size="16" />文本框</button>
        <button type="button" :class="{ 'is-active': sourceMode }" @click="toggleSourceMode"><Code2 :size="16" />源码</button>
        <button type="button" class="slidev-editor__present-button" :disabled="!currentPage" @click="startPresentation"><Play :size="16" />演示</button>
      </div>

      <section v-if="sourceMode" class="slidev-editor__source-panel">
        <textarea v-model="sourceDraft" spellcheck="false" aria-label="Slidev Markdown 源码"></textarea>
        <footer>
          <span v-if="sourceError" role="alert">{{ sourceError }}</span>
          <button type="button" @click="applySourceDraft">应用源码</button>
        </footer>
      </section>

      <template v-else-if="currentPage">
        <div class="slidev-editor__stage">
          <div ref="canvas" class="slidev-canvas" :data-layout="currentPage.layout">
            <section class="slidev-canvas__flow">
              <input
                v-if="editing?.kind === 'title'"
                ref="editControl"
                v-model="editingDraft"
                class="slidev-canvas__title-editor"
                aria-label="页面标题"
                @blur="commitEdit"
                @keydown.enter.prevent="commitEdit"
                @keydown.esc.prevent="cancelEdit"
              />
              <h1 v-else title="双击编辑标题" @dblclick="beginEdit('title')">{{ currentPage.title }}</h1>

              <textarea
                v-if="editing?.kind === 'body'"
                ref="editControl"
                v-model="editingDraft"
                class="slidev-canvas__body-editor"
                aria-label="页面正文"
                @blur="commitEdit"
                @keydown.esc.prevent="cancelEdit"
              ></textarea>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else class="slidev-canvas__body markdown-preview" title="双击编辑正文" @dblclick="beginEdit('body')" v-html="currentBodyHtml"></div>
            </section>

            <article
              v-for="box in currentPage.textBoxes"
              :key="box.id"
              class="slidev-textbox"
              :style="boxStyle(box)"
              @pointerdown="startBoxGesture($event, box, 'move')"
              @dblclick.stop="beginEdit('textbox', box.id)"
            >
              <textarea
                v-if="editing?.kind === 'textbox' && editing.id === box.id"
                ref="editControl"
                v-model="editingDraft"
                aria-label="文本框内容"
                @pointerdown.stop
                @blur="commitEdit"
                @keydown.esc.prevent="cancelEdit"
              ></textarea>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else class="markdown-preview" v-html="renderAiMarkdown(box.markdown)"></div>
              <button type="button" class="slidev-textbox__delete" aria-label="删除文本框" @pointerdown.stop @click.stop="removeTextBox(box.id)"><X :size="12" /></button>
              <span class="slidev-textbox__resize" @pointerdown="startBoxGesture($event, box, 'resize')"></span>
            </article>
          </div>
        </div>

        <div v-if="currentPage.hasAdvancedContent" class="slidev-editor__advanced-notice">
          当前页包含高级 Slidev 内容；可正常保留，使用源码模式编辑。
        </div>
        <label class="slidev-editor__notes">
          <span>演讲者备注</span>
          <textarea :value="currentPage.notes" placeholder="仅演讲者可见的提示…" @change="handleNotesChange"></textarea>
        </label>
      </template>
    </main>

    <Teleport to="body">
      <section v-if="isPresenting && presentationPage" class="slidev-presentation">
        <div class="slidev-presentation__canvas">
          <section class="slidev-canvas__flow">
            <h1>{{ presentationPage.title }}</h1>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="slidev-canvas__body markdown-preview" v-html="presentationBodyHtml"></div>
          </section>
          <article v-for="box in presentationPage.textBoxes" :key="box.id" class="slidev-textbox slidev-textbox--present" :style="boxStyle(box)">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="markdown-preview" v-html="renderAiMarkdown(box.markdown)"></div>
          </article>
        </div>
        <div class="slidev-presentation__controls">
          <button type="button" :disabled="presentationIndex <= 0" aria-label="上一页" @click="changePresentationPage(-1)"><ChevronLeft :size="22" /></button>
          <span>{{ presentationIndex + 1 }} / {{ pages.length }}</span>
          <button type="button" :disabled="presentationIndex >= pages.length - 1" aria-label="下一页" @click="changePresentationPage(1)"><ChevronRight :size="22" /></button>
          <button type="button" aria-label="全屏" @click="requestPresentationFullscreen"><Maximize2 :size="20" /></button>
          <button type="button" aria-label="退出演示" @click="closePresentation"><X :size="22" /></button>
        </div>
      </section>
    </Teleport>
  </div>
</template>
