<script setup lang="ts">
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ClipboardPaste,
  Code,
  CopyPlus,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Highlighter,
  ImagePlus,
  Italic,
  Link,
  Palette,
  Quote,
  Redo2,
  Strikethrough,
  Subscript,
  Superscript,
  Table2,
  Trash2,
  Underline,
  Undo2,
  X,
  Sigma,
} from '@lucide/vue'
import { EditorContent, type Editor, useEditor } from '@tiptap/vue-3'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from 'reka-ui'
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { createEditorExtensions } from './createEditorExtensions'
import {
  cloneBlockForInsertion,
  hasRetainedBlock,
  retainBlock,
  takeRetainedBlock,
} from './blockClipboard'
import { ensureTopLevelBlockIds } from './blockId'
import {
  CONTEXT_INSERT_BLOCK_TYPES,
  TRANSFORM_BLOCK_TYPES,
  getContextInsertContent,
  type BlockMenuIcon,
  type RegisteredBlockType,
} from './blockTypeRegistry'
import { isSameEditorContent, normalizeEditorContent } from './editorContent'
import { readImageFileAsDataUrl } from './imageFile'
import { parseMarkdownDocument } from './markdownImport'
import { assetService, getAssetUrl } from '@/infrastructure/assets/AssetService'
import type { TiptapDocumentJson } from '@/models/document'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@/models/settings'
import { NButton, NButtonGroup, NColorPicker, NIcon, NPopover, NTooltip } from '@/ui'

const props = withDefaults(
  defineProps<{
    modelValue?: TiptapDocumentJson
    readonly?: boolean
    autofocus?: boolean
    ariaLabel?: string
    settings?: AppSettings
    internalDocuments?: Array<{ id: string; title: string }>
    documentId?: string
  }>(),
  {
    modelValue: undefined,
    readonly: false,
    autofocus: false,
    ariaLabel: '文档编辑器',
    settings: () => ({ ...DEFAULT_APP_SETTINGS }),
    internalDocuments: () => [],
    documentId: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: TiptapDocumentJson]
  textUpdate: [value: string]
  ready: []
  destroy: []
  imageError: [message: string]
  openDocument: [documentId: string]
}>()

const initialContent = computed(() =>
  ensureTopLevelBlockIds(normalizeEditorContent(props.modelValue)),
)
const DEFAULT_TEXT_COLOR = '#333333'
const DEFAULT_HIGHLIGHT_COLOR = '#fef08a'
const RECENT_TEXT_COLORS_STORAGE_KEY = 'my-notebook:recent-text-colors'
const RECENT_HIGHLIGHT_COLORS_STORAGE_KEY = 'my-notebook:recent-highlight-colors'
const TEXT_COLOR_SWATCHES = [
  '#111827',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#2563eb',
  '#7c3aed',
]
const HIGHLIGHT_COLOR_SWATCHES = [
  '#fef08a',
  '#fde68a',
  '#fed7aa',
  '#fecaca',
  '#ddd6fe',
  '#bfdbfe',
  '#bbf7d0',
  '#a7f3d0',
]
const textColor = ref(DEFAULT_TEXT_COLOR)
const highlightColor = ref(DEFAULT_HIGHLIGHT_COLOR)
const recentTextColors = ref<string[]>(loadRecentColors(RECENT_TEXT_COLORS_STORAGE_KEY))
const recentHighlightColors = ref<string[]>(loadRecentColors(RECENT_HIGHLIGHT_COLORS_STORAGE_KEY))
const colorPopoverOpen = ref(false)
const highlightPopoverOpen = ref(false)
const imageFileInput = ref<InstanceType<typeof globalThis.HTMLInputElement> | null>(null)
const attachmentFileInput = ref<InstanceType<typeof globalThis.HTMLInputElement> | null>(null)
const pendingImagePosition = ref<number | null>(null)
const pendingAttachmentPosition = ref<number | null>(null)
const contextBlockPosition = ref<number | null>(null)
const retainedBlockAvailable = ref(hasRetainedBlock())
const INTERNAL_DOCUMENT_LINK_PREFIX = '#document='
const editorAppearanceStyle = computed(() => ({
  '--editor-content-width': { compact: '720px', standard: '850px', wide: '1000px' }[
    props.settings.contentWidth
  ],
  '--editor-font-size': { small: '14px', standard: '16px', large: '18px' }[props.settings.fontSize],
  '--editor-line-height': { compact: '1.5', comfortable: '1.72', relaxed: '2' }[
    props.settings.lineHeight
  ],
}))
const bubbleMenuOptions = {
  strategy: 'fixed' as const,
  placement: 'top' as const,
  offset: 10,
  flip: true,
  shift: {
    padding: 14,
  },
  inline: true,
}
const MENU_ICON_COMPONENTS = {
  code: Code,
  fileText: FileText,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  heading4: Heading4,
  image: ImagePlus,
  quote: Quote,
  sigma: Sigma,
  table: Table2,
}

const editor = useEditor({
  content: initialContent.value,
  editable: !props.readonly,
  autofocus: props.autofocus,
  extensions: createEditorExtensions(),
  editorProps: {
    attributes: {
      'aria-label': props.ariaLabel,
      class: 'editor-shell__content',
      spellcheck: props.settings.spellcheck ? 'true' : 'false',
    },
    handlePaste: (view, event) => {
      const imageFile = getClipboardImageFile(event)
      if (!imageFile || props.readonly) return false

      void insertImageFile(imageFile, view.state.selection.from)
      return true
    },
  },
  onCreate: ({ editor: activeEditor }) => {
    syncTextColor(activeEditor)
    syncHighlightColor(activeEditor)
    emit('ready')
  },
  onSelectionUpdate: ({ editor: activeEditor }) => {
    syncTextColor(activeEditor)
    syncHighlightColor(activeEditor)
  },
  onUpdate: ({ editor: activeEditor }) => {
    syncTextColor(activeEditor)
    syncHighlightColor(activeEditor)
    emit('update:modelValue', activeEditor.getJSON() as TiptapDocumentJson)
    emit('textUpdate', activeEditor.getText())
  },
})

function shouldShowBubbleMenu({
  editor: activeEditor,
  from,
  to,
}: {
  editor: Editor
  from: number
  to: number
}): boolean {
  if (
    props.readonly ||
    !activeEditor.isEditable ||
    activeEditor.isActive('codeBlock') ||
    isRangeInsideCodeBlock(activeEditor, from, to)
  ) {
    return false
  }

  if (colorPopoverOpen.value || highlightPopoverOpen.value) {
    return true
  }

  return from !== to
}

function isActive(name: string, attributes?: Record<string, unknown>): boolean {
  return editor.value?.isActive(name, attributes) ?? false
}

function isRangeInsideCodeBlock(activeEditor: Editor, from: number, to: number): boolean {
  return (
    isPositionInsideNode(activeEditor, from, 'codeBlock') ||
    isPositionInsideNode(activeEditor, Math.max(from, to - 1), 'codeBlock')
  )
}

function isPositionInsideNode(activeEditor: Editor, position: number, nodeName: string): boolean {
  const doc = activeEditor.state.doc
  const resolvedPosition = doc.resolve(Math.max(0, Math.min(position, doc.content.size)))

  for (let depth = resolvedPosition.depth; depth >= 0; depth -= 1) {
    if (resolvedPosition.node(depth).type.name === nodeName) {
      return true
    }
  }

  return false
}

function toggleBold(): void {
  editor.value?.chain().focus().toggleBold().run()
}

function toggleItalic(): void {
  editor.value?.chain().focus().toggleItalic().run()
}

function toggleStrike(): void {
  editor.value?.chain().focus().toggleStrike().run()
}

function toggleUnderline(): void {
  editor.value?.chain().focus().toggleUnderline().run()
}

function toggleInlineCode(): void {
  editor.value?.chain().focus().toggleCode().run()
}

function toggleSubscript(): void {
  editor.value?.chain().focus().toggleMark('subscript').run()
}

function toggleSuperscript(): void {
  editor.value?.chain().focus().toggleMark('superscript').run()
}

function setTextAlignment(alignment: 'left' | 'center' | 'right'): void {
  editor.value?.chain().focus().setTextAlign(alignment).run()
}

function isTextAligned(alignment: 'left' | 'center' | 'right'): boolean {
  return editor.value?.isActive({ textAlign: alignment }) ?? false
}

function setLink(): void {
  const activeEditor = editor.value
  if (!activeEditor) {
    return
  }

  const currentHref = getCurrentLinkHref(activeEditor)
  const href = globalThis.prompt('输入链接地址', currentHref)

  if (href === null) {
    activeEditor.commands.focus()
    return
  }

  if (href.trim() === '') {
    activeEditor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }

  activeEditor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
}

function undo(): void {
  editor.value?.chain().focus().undo().run()
}

function redo(): void {
  editor.value?.chain().focus().redo().run()
}

function insertImage(): void {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable) return

  pendingImagePosition.value = activeEditor.state.selection.from
  imageFileInput.value?.click()
}

function insertAttachment(): void {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable) return

  pendingAttachmentPosition.value = activeEditor.state.selection.from
  attachmentFileInput.value?.click()
}

function insertMarkdown(markdown: string): void {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable || !markdown.trim()) return
  const parsed = parseMarkdownDocument(markdown, 'AI 输出')
  const content = parsed.content.content ?? [{ type: 'paragraph' }]
  activeEditor.chain().focus().insertContent(content).run()
}

function captureContextBlock(event: InstanceType<typeof globalThis.MouseEvent>): void {
  const target = event.target
  const block =
    target instanceof globalThis.Element
      ? target.closest<InstanceType<typeof globalThis.HTMLElement>>('[data-editor-block-pos]')
      : null
  const position = Number(block?.dataset.editorBlockPos)
  contextBlockPosition.value = Number.isFinite(position) ? position : null
}

function handleEditorClick(event: InstanceType<typeof globalThis.MouseEvent>): void {
  const target = event.target
  const anchor = target instanceof globalThis.Element ? target.closest('a') : null
  const href = anchor?.getAttribute('href') ?? ''
  if (!href.startsWith(INTERNAL_DOCUMENT_LINK_PREFIX)) return

  event.preventDefault()
  emit('openDocument', decodeURIComponent(href.slice(INTERNAL_DOCUMENT_LINK_PREFIX.length)))
}

function focusContextBlock(): boolean {
  const activeEditor = editor.value
  const position = contextBlockPosition.value
  if (!activeEditor || position === null || !activeEditor.state.doc.nodeAt(position)) return false

  activeEditor.commands.setTextSelection(
    Math.min(position + 1, activeEditor.state.doc.content.size),
  )
  return true
}

function getBlockMenuIconComponent(icon: BlockMenuIcon) {
  return icon.kind === 'lucide' ? MENU_ICON_COMPONENTS[icon.name] : null
}

function transformContextBlock(blockType: RegisteredBlockType): void {
  const activeEditor = editor.value
  if (!activeEditor || !blockType.transform || !focusContextBlock()) return

  blockType.transform(activeEditor)
}

function copyContextBlock(): void {
  const activeEditor = editor.value
  const position = contextBlockPosition.value
  if (!activeEditor || position === null) return
  const node = activeEditor.state.doc.nodeAt(position)
  if (!node) return

  if (props.settings.blockCopyBehavior === 'clipboard') {
    retainBlock(node.toJSON())
    retainedBlockAvailable.value = true
    return
  }

  activeEditor
    .chain()
    .focus()
    .insertContentAt(position + node.nodeSize, cloneBlockForInsertion(node.toJSON()))
    .run()
}

function pasteRetainedBlock(): void {
  const block = takeRetainedBlock()
  if (!block) return

  retainedBlockAvailable.value = false
  insertAfterContextBlock(block as Record<string, unknown>)
}

function deleteContextBlock(): void {
  const activeEditor = editor.value
  const position = contextBlockPosition.value
  if (!activeEditor || position === null) return
  const node = activeEditor.state.doc.nodeAt(position)
  if (!node) return

  activeEditor
    .chain()
    .focus()
    .deleteRange({ from: position, to: position + node.nodeSize })
    .run()
}

function insertAfterContextBlock(content: Record<string, unknown>): void {
  const activeEditor = editor.value
  const position = contextBlockPosition.value
  if (!activeEditor) return
  const node = position === null ? null : activeEditor.state.doc.nodeAt(position)
  const insertionPosition =
    node && position !== null ? position + node.nodeSize : activeEditor.state.selection.to
  activeEditor.chain().focus().insertContentAt(insertionPosition, content).run()
}

function insertRegisteredBlockAfterContextBlock(blockType: RegisteredBlockType): void {
  if (blockType.contextInsert?.kind === 'image-upload') {
    insertImageAfterContextBlock()
    return
  }
  if (blockType.contextInsert?.kind === 'file-upload') {
    insertAttachmentAfterContextBlock()
    return
  }

  const content = getContextInsertContent(blockType)
  if (!content) return

  insertAfterContextBlock(content as Record<string, unknown>)
}

function insertImageAfterContextBlock(): void {
  const activeEditor = editor.value
  const position = contextBlockPosition.value
  const node = position === null ? null : activeEditor?.state.doc.nodeAt(position)
  if (activeEditor && node && position !== null) {
    activeEditor.commands.setTextSelection(
      Math.min(position + node.nodeSize, activeEditor.state.doc.content.size),
    )
  }
  insertImage()
}

function insertAttachmentAfterContextBlock(): void {
  const activeEditor = editor.value
  const position = contextBlockPosition.value
  const node = position === null ? null : activeEditor?.state.doc.nodeAt(position)
  if (activeEditor && node && position !== null) {
    activeEditor.commands.setTextSelection(
      Math.min(position + node.nodeSize, activeEditor.state.doc.content.size),
    )
  }
  insertAttachment()
}

function insertInternalDocumentLink(target: { id: string; title: string }): void {
  const activeEditor = editor.value
  if (!activeEditor) return
  const href = `${INTERNAL_DOCUMENT_LINK_PREFIX}${encodeURIComponent(target.id)}`

  if (activeEditor.state.selection.empty) {
    activeEditor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: target.title || '未命名文档',
        marks: [{ type: 'link', attrs: { href } }],
      })
      .run()
    return
  }

  activeEditor.chain().focus().setLink({ href }).run()
}

async function handleImageFileChange(event: InstanceType<typeof globalThis.Event>): Promise<void> {
  const input = event.target as InstanceType<typeof globalThis.HTMLInputElement>
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  await insertImageFile(file, pendingImagePosition.value ?? undefined)
  pendingImagePosition.value = null
}

async function handleAttachmentFileChange(
  event: InstanceType<typeof globalThis.Event>,
): Promise<void> {
  const input = event.target as InstanceType<typeof globalThis.HTMLInputElement>
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  await insertAttachmentFile(file, pendingAttachmentPosition.value ?? undefined)
  pendingAttachmentPosition.value = null
}

async function insertImageFile(
  file: InstanceType<typeof globalThis.File>,
  requestedPosition?: number,
): Promise<void> {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable) return

  try {
    let src = ''
    try {
      const asset = await assetService.storeFile(file, props.documentId || null)
      src = getAssetUrl(asset.id)
    } catch {
      src = await readImageFileAsDataUrl(file)
    }
    const position = Math.max(
      0,
      Math.min(
        requestedPosition ?? activeEditor.state.selection.from,
        activeEditor.state.doc.content.size,
      ),
    )

    activeEditor
      .chain()
      .focus()
      .insertContentAt(position, [
        {
          type: 'imageFigure',
          attrs: {
            src,
            alt: file.name,
            originalName: file.name,
          },
        },
        { type: 'paragraph' },
      ])
      .run()
  } catch (error) {
    emit('imageError', error instanceof Error ? error.message : '无法读取图片')
  }
}

async function insertAttachmentFile(
  file: InstanceType<typeof globalThis.File>,
  requestedPosition?: number,
): Promise<void> {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable) return

  try {
    const asset = await assetService.storeFile(file, props.documentId || null)
    const position = Math.max(
      0,
      Math.min(
        requestedPosition ?? activeEditor.state.selection.from,
        activeEditor.state.doc.content.size,
      ),
    )

    activeEditor
      .chain()
      .focus()
      .insertContentAt(position, [
        {
          type: 'attachmentBlock',
          attrs: {
            assetId: asset.id,
            name: asset.originalName,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
          },
        },
        { type: 'paragraph' },
      ])
      .run()
  } catch (error) {
    emit('imageError', error instanceof Error ? error.message : '无法保存附件')
  }
}

function getClipboardImageFile(
  event: InstanceType<typeof globalThis.ClipboardEvent>,
): InstanceType<typeof globalThis.File> | null {
  const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
    item.type.startsWith('image/'),
  )
  if (file) return file

  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue

    const clipboardFile = item.getAsFile()
    if (clipboardFile) return clipboardFile
  }

  return null
}

function setTextColor(color: string | null): void {
  const activeEditor = editor.value
  const nextColor = color?.trim()
  if (!activeEditor || !nextColor) {
    return
  }

  textColor.value = nextColor
  rememberTextColor(nextColor)
  activeEditor.chain().focus().setColor(nextColor).run()
}

function previewTextColor(color: string | null): void {
  const activeEditor = editor.value
  const nextColor = color?.trim()
  if (!activeEditor || !nextColor) {
    return
  }

  textColor.value = nextColor
  activeEditor.chain().setColor(nextColor).run()
}

function setHighlightColor(color: string | null): void {
  const activeEditor = editor.value
  const nextColor = color?.trim()
  if (!activeEditor || !nextColor) {
    return
  }

  highlightColor.value = nextColor
  rememberRecentColor(nextColor, recentHighlightColors, RECENT_HIGHLIGHT_COLORS_STORAGE_KEY)
  activeEditor.chain().focus().setHighlight({ color: nextColor }).run()
}

function previewHighlightColor(color: string | null): void {
  const activeEditor = editor.value
  const nextColor = color?.trim()
  if (!activeEditor || !nextColor) {
    return
  }

  highlightColor.value = nextColor
  activeEditor.chain().setHighlight({ color: nextColor }).run()
}

function loadRecentColors(storageKey: string): string[] {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey)
    if (!stored) return []
    const colors = JSON.parse(stored)
    return Array.isArray(colors)
      ? colors.filter((color): color is string => typeof color === 'string').slice(0, 6)
      : []
  } catch {
    return []
  }
}

function rememberTextColor(color: string): void {
  rememberRecentColor(color, recentTextColors, RECENT_TEXT_COLORS_STORAGE_KEY)
}

function rememberRecentColor(color: string, recentColors: Ref<string[]>, storageKey: string): void {
  const normalizedColor = color.toLowerCase()
  recentColors.value = [
    normalizedColor,
    ...recentColors.value.filter((recentColor) => recentColor.toLowerCase() !== normalizedColor),
  ].slice(0, 6)

  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(recentColors.value))
  } catch {
    // Storage can be unavailable in restricted webviews; the in-memory history still works.
  }
}

function unsetTextColor(): void {
  const activeEditor = editor.value
  if (!activeEditor) {
    return
  }

  textColor.value = DEFAULT_TEXT_COLOR
  activeEditor.chain().focus().unsetColor().removeEmptyTextStyle().run()
}

function unsetHighlightColor(): void {
  const activeEditor = editor.value
  if (!activeEditor) {
    return
  }

  highlightColor.value = DEFAULT_HIGHLIGHT_COLOR
  activeEditor.chain().focus().unsetHighlight().run()
}

function syncTextColor(activeEditor: Editor): void {
  textColor.value = getCurrentTextColor(activeEditor) || DEFAULT_TEXT_COLOR
}

function syncHighlightColor(activeEditor: Editor): void {
  highlightColor.value = getCurrentHighlightColor(activeEditor) || DEFAULT_HIGHLIGHT_COLOR
}

function getCurrentTextColor(activeEditor: Editor): string {
  const attributes = activeEditor.getAttributes('textStyle')

  if (isRecord(attributes) && typeof attributes.color === 'string') {
    return attributes.color
  }

  return ''
}

function hasActiveTextColor(): boolean {
  const activeEditor = editor.value
  return activeEditor ? getCurrentTextColor(activeEditor) !== '' : false
}

function getCurrentHighlightColor(activeEditor: Editor): string {
  const attributes = activeEditor.getAttributes('highlight')

  if (isRecord(attributes) && typeof attributes.color === 'string') {
    return attributes.color
  }

  return ''
}

function hasActiveHighlight(): boolean {
  const activeEditor = editor.value
  return activeEditor ? activeEditor.isActive('highlight') : false
}

function getBubbleMenuContainer() {
  return globalThis.document.body
}

function getCurrentLinkHref(activeEditor: Editor): string {
  const attributes = activeEditor.getAttributes('link')

  if (isRecord(attributes) && typeof attributes.href === 'string') {
    return attributes.href
  }

  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

watch(
  () => props.readonly,
  (readonly) => {
    editor.value?.setEditable(!readonly, false)
  },
)

watch(
  () => props.settings.spellcheck,
  (spellcheck) => {
    editor.value?.view.dom.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
  },
)

watch(
  () => props.modelValue,
  (nextContent) => {
    if (!editor.value || !nextContent) {
      return
    }

    const currentContent = editor.value.getJSON() as TiptapDocumentJson
    const contentWithBlockIds = ensureTopLevelBlockIds(normalizeEditorContent(nextContent))
    if (isSameEditorContent(currentContent, contentWithBlockIds)) {
      return
    }

    editor.value.commands.setContent(contentWithBlockIds, {
      emitUpdate: false,
      errorOnInvalidContent: true,
    })
  },
)

onBeforeUnmount(() => {
  editor.value?.destroy()
  emit('destroy')
})

defineExpose({
  editor,
  shouldShowBubbleMenu,
  getJSON: () => editor.value?.getJSON() as TiptapDocumentJson | undefined,
  getText: () => editor.value?.getText() ?? '',
  focus: () => editor.value?.commands.focus(),
  insertImage,
  insertAttachment,
  insertMarkdown,
  insertInternalDocumentLink,
  copyContextBlock,
  pasteRetainedBlock,
  setContextBlockPosition: (position: number) => {
    contextBlockPosition.value = position
  },
})
</script>

<template>
  <ContextMenuRoot>
    <ContextMenuTrigger as-child>
      <div
        class="editor-shell"
        :class="{
          'editor-shell--readonly': readonly,
          'editor-shell--hide-block-handles': !settings.showBlockHandles,
        }"
        :style="editorAppearanceStyle"
        @click="handleEditorClick"
        @contextmenu="captureContextBlock"
      >
        <input
          ref="imageFileInput"
          class="editor-shell__image-input"
          type="file"
          accept="image/*"
          tabindex="-1"
          aria-hidden="true"
          @change="handleImageFileChange"
        />
        <input
          ref="attachmentFileInput"
          class="editor-shell__image-input"
          type="file"
          tabindex="-1"
          aria-hidden="true"
          @change="handleAttachmentFileChange"
        />
        <BubbleMenu
          v-if="editor"
          class="bubble-menu-layer"
          :editor="editor"
          :should-show="shouldShowBubbleMenu"
          :append-to="getBubbleMenuContainer"
          :options="bubbleMenuOptions"
          plugin-key="format-bubble-menu"
        >
          <NButtonGroup class="bubble-toolbar" role="toolbar" aria-label="文本格式">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('bold') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="粗体"
                  @click="toggleBold"
                >
                  <template #icon>
                    <NIcon :size="16"><Bold /></NIcon>
                  </template>
                </NButton>
              </template>
              粗体
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('italic') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="斜体"
                  @click="toggleItalic"
                >
                  <template #icon>
                    <NIcon :size="16"><Italic /></NIcon>
                  </template>
                </NButton>
              </template>
              斜体
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('strike') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="删除线"
                  @click="toggleStrike"
                >
                  <template #icon>
                    <NIcon :size="16"><Strikethrough /></NIcon>
                  </template>
                </NButton>
              </template>
              删除线
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('underline') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="下划线"
                  @click="toggleUnderline"
                >
                  <template #icon>
                    <NIcon :size="16"><Underline /></NIcon>
                  </template>
                </NButton>
              </template>
              下划线
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('code') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="行内代码"
                  @click="toggleInlineCode"
                >
                  <template #icon>
                    <NIcon :size="16"><Code /></NIcon>
                  </template>
                </NButton>
              </template>
              行内代码
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('subscript') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="下标"
                  @click="toggleSubscript"
                >
                  <template #icon
                    ><NIcon :size="16"><Subscript /></NIcon
                  ></template>
                </NButton>
              </template>
              下标（Ctrl+,）
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('superscript') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="上标"
                  @click="toggleSuperscript"
                >
                  <template #icon
                    ><NIcon :size="16"><Superscript /></NIcon
                  ></template>
                </NButton>
              </template>
              上标（Ctrl+.）
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isActive('link') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="链接"
                  @click="setLink"
                >
                  <template #icon>
                    <NIcon :size="16"><Link /></NIcon>
                  </template>
                </NButton>
              </template>
              链接
            </NTooltip>
            <span class="bubble-toolbar__separator" aria-hidden="true"></span>
            <NPopover
              v-model:show="colorPopoverOpen"
              trigger="click"
              placement="bottom"
              :z-index="1400"
              :show-arrow="false"
            >
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button bubble-toolbar__button--color"
                  :class="{ 'bubble-toolbar__button--active': hasActiveTextColor() }"
                  size="small"
                  quaternary
                  circle
                  aria-label="文字颜色"
                  title="文字颜色"
                  @mousedown.prevent
                >
                  <template #icon>
                    <NIcon :size="16"><Palette /></NIcon>
                  </template>
                  <span
                    class="bubble-toolbar__color-mark"
                    :style="{ backgroundColor: textColor }"
                  ></span>
                </NButton>
              </template>
              <div class="bubble-color-panel">
                <div v-if="recentTextColors.length" class="bubble-color-panel__section">
                  <span class="bubble-color-panel__label">最近使用</span>
                  <div
                    class="bubble-color-panel__swatches bubble-color-panel__swatches--recent"
                    aria-label="最近使用的文字颜色"
                  >
                    <button
                      v-for="recentColor in recentTextColors"
                      :key="recentColor"
                      class="bubble-color-panel__swatch"
                      :class="{
                        'bubble-color-panel__swatch--active':
                          textColor.toLowerCase() === recentColor.toLowerCase(),
                      }"
                      type="button"
                      :style="{ backgroundColor: recentColor }"
                      :aria-label="`设置最近使用的文字颜色 ${recentColor}`"
                      @mousedown.prevent
                      @click="setTextColor(recentColor)"
                    ></button>
                  </div>
                </div>
                <span class="bubble-color-panel__label">常用颜色</span>
                <div class="bubble-color-panel__swatches" aria-label="常用文字颜色">
                  <button
                    v-for="swatch in TEXT_COLOR_SWATCHES"
                    :key="swatch"
                    class="bubble-color-panel__swatch"
                    :class="{
                      'bubble-color-panel__swatch--active':
                        textColor.toLowerCase() === swatch.toLowerCase(),
                    }"
                    type="button"
                    :style="{ backgroundColor: swatch }"
                    :aria-label="`设置文字颜色 ${swatch}`"
                    @mousedown.prevent
                    @click="setTextColor(swatch)"
                  ></button>
                </div>
                <NColorPicker
                  v-model:value="textColor"
                  class="bubble-color-panel__picker"
                  :show-alpha="false"
                  :modes="['hex']"
                  size="small"
                  @update:value="previewTextColor"
                  @change:value="setTextColor"
                />
                <NButton
                  class="bubble-color-panel__clear"
                  size="small"
                  quaternary
                  @mousedown.prevent
                  @click="unsetTextColor"
                >
                  <template #icon>
                    <NIcon :size="14"><X /></NIcon>
                  </template>
                  清除颜色
                </NButton>
              </div>
            </NPopover>
            <NPopover
              v-model:show="highlightPopoverOpen"
              trigger="click"
              placement="bottom"
              :z-index="1400"
              :show-arrow="false"
            >
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button bubble-toolbar__button--color"
                  :class="{ 'bubble-toolbar__button--active': hasActiveHighlight() }"
                  size="small"
                  quaternary
                  circle
                  aria-label="荧光笔"
                  title="荧光笔"
                  @mousedown.prevent
                >
                  <template #icon>
                    <NIcon :size="16"><Highlighter /></NIcon>
                  </template>
                  <span
                    class="bubble-toolbar__color-mark"
                    :style="{ backgroundColor: highlightColor }"
                  ></span>
                </NButton>
              </template>
              <div class="bubble-color-panel">
                <div v-if="recentHighlightColors.length" class="bubble-color-panel__section">
                  <span class="bubble-color-panel__label">最近使用</span>
                  <div
                    class="bubble-color-panel__swatches bubble-color-panel__swatches--recent"
                    aria-label="最近使用的高亮颜色"
                  >
                    <button
                      v-for="recentColor in recentHighlightColors"
                      :key="recentColor"
                      class="bubble-color-panel__swatch"
                      :class="{
                        'bubble-color-panel__swatch--active':
                          highlightColor.toLowerCase() === recentColor.toLowerCase(),
                      }"
                      type="button"
                      :style="{ backgroundColor: recentColor }"
                      :aria-label="`设置最近使用的高亮颜色 ${recentColor}`"
                      @mousedown.prevent
                      @click="setHighlightColor(recentColor)"
                    ></button>
                  </div>
                </div>
                <span class="bubble-color-panel__label">常用颜色</span>
                <div class="bubble-color-panel__swatches" aria-label="常用高亮颜色">
                  <button
                    v-for="swatch in HIGHLIGHT_COLOR_SWATCHES"
                    :key="swatch"
                    class="bubble-color-panel__swatch"
                    :class="{
                      'bubble-color-panel__swatch--active':
                        highlightColor.toLowerCase() === swatch.toLowerCase(),
                    }"
                    type="button"
                    :style="{ backgroundColor: swatch }"
                    :aria-label="`设置高亮颜色 ${swatch}`"
                    @mousedown.prevent
                    @click="setHighlightColor(swatch)"
                  ></button>
                </div>
                <NColorPicker
                  v-model:value="highlightColor"
                  class="bubble-color-panel__picker"
                  :show-alpha="false"
                  :modes="['hex']"
                  size="small"
                  @update:value="previewHighlightColor"
                  @change:value="setHighlightColor"
                />
                <NButton
                  class="bubble-color-panel__clear"
                  size="small"
                  quaternary
                  @mousedown.prevent
                  @click="unsetHighlightColor"
                >
                  <template #icon>
                    <NIcon :size="14"><X /></NIcon>
                  </template>
                  清除高亮
                </NButton>
              </div>
            </NPopover>
            <span class="bubble-toolbar__separator" aria-hidden="true"></span>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isTextAligned('left') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="左对齐"
                  @mousedown.prevent
                  @click="setTextAlignment('left')"
                >
                  <template #icon>
                    <NIcon :size="16"><AlignLeft /></NIcon>
                  </template>
                </NButton>
              </template>
              左对齐
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isTextAligned('center') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="居中对齐"
                  @mousedown.prevent
                  @click="setTextAlignment('center')"
                >
                  <template #icon>
                    <NIcon :size="16"><AlignCenter /></NIcon>
                  </template>
                </NButton>
              </template>
              居中对齐
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  :class="{ 'bubble-toolbar__button--active': isTextAligned('right') }"
                  size="small"
                  quaternary
                  circle
                  aria-label="右对齐"
                  @mousedown.prevent
                  @click="setTextAlignment('right')"
                >
                  <template #icon>
                    <NIcon :size="16"><AlignRight /></NIcon>
                  </template>
                </NButton>
              </template>
              右对齐
            </NTooltip>
            <span class="bubble-toolbar__separator" aria-hidden="true"></span>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  size="small"
                  quaternary
                  circle
                  aria-label="撤销"
                  @click="undo"
                >
                  <template #icon>
                    <NIcon :size="16"><Undo2 /></NIcon>
                  </template>
                </NButton>
              </template>
              撤销
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  class="bubble-toolbar__button"
                  size="small"
                  quaternary
                  circle
                  aria-label="重做"
                  @click="redo"
                >
                  <template #icon>
                    <NIcon :size="16"><Redo2 /></NIcon>
                  </template>
                </NButton>
              </template>
              重做
            </NTooltip>
          </NButtonGroup>
        </BubbleMenu>
        <EditorContent :editor="editor" />
      </div>
    </ContextMenuTrigger>

    <ContextMenuPortal>
      <ContextMenuContent class="editor-context-menu" :collision-padding="10">
        <ContextMenuLabel class="editor-context-menu__label">文章操作</ContextMenuLabel>
        <ContextMenuItem
          class="editor-context-menu__item"
          :disabled="!editor?.can().undo()"
          @select="editor?.chain().focus().undo().run()"
        >
          <Undo2 :size="15" /><span>撤销</span><kbd>Ctrl Z</kbd>
        </ContextMenuItem>
        <ContextMenuItem
          class="editor-context-menu__item"
          :disabled="!editor?.can().redo()"
          @select="editor?.chain().focus().redo().run()"
        >
          <Redo2 :size="15" /><span>重做</span><kbd>Ctrl Y</kbd>
        </ContextMenuItem>
        <ContextMenuSeparator class="editor-context-menu__separator" />

        <ContextMenuSub>
          <ContextMenuSubTrigger class="editor-context-menu__item editor-context-menu__item--sub">
            <FileText :size="15" /><span>转换块类型</span><span>›</span>
          </ContextMenuSubTrigger>
          <ContextMenuPortal>
            <ContextMenuSubContent class="editor-context-menu">
              <ContextMenuItem
                v-for="blockType in TRANSFORM_BLOCK_TYPES"
                :key="blockType.id"
                class="editor-context-menu__item"
                @select="transformContextBlock(blockType)"
              >
                <component
                  :is="getBlockMenuIconComponent(blockType.menuIcon)"
                  v-if="blockType.menuIcon.kind === 'lucide'"
                  :size="15"
                />
                <span v-else class="editor-context-menu__glyph">{{
                  blockType.menuIcon.value
                }}</span>
                <span>{{ blockType.title }}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuPortal>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger class="editor-context-menu__item editor-context-menu__item--sub">
            <Link :size="15" /><span>链接到知识库文档</span><span>›</span>
          </ContextMenuSubTrigger>
          <ContextMenuPortal>
            <ContextMenuSubContent class="editor-context-menu editor-context-menu--documents">
              <ContextMenuItem
                v-if="internalDocuments.length === 0"
                class="editor-context-menu__item"
                disabled
                >暂无其他文档</ContextMenuItem
              >
              <ContextMenuItem
                v-for="target in internalDocuments"
                :key="target.id"
                class="editor-context-menu__item"
                @select="insertInternalDocumentLink(target)"
              >
                <FileText :size="15" /><span>{{ target.title || '未命名文档' }}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuPortal>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger class="editor-context-menu__item editor-context-menu__item--sub">
            <ImagePlus :size="15" /><span>插入块</span><span>›</span>
          </ContextMenuSubTrigger>
          <ContextMenuPortal>
            <ContextMenuSubContent class="editor-context-menu">
              <ContextMenuItem
                v-for="blockType in CONTEXT_INSERT_BLOCK_TYPES"
                :key="blockType.id"
                class="editor-context-menu__item"
                @select="insertRegisteredBlockAfterContextBlock(blockType)"
              >
                <component
                  :is="getBlockMenuIconComponent(blockType.menuIcon)"
                  v-if="blockType.menuIcon.kind === 'lucide'"
                  :size="15"
                />
                <span v-else class="editor-context-menu__glyph">{{
                  blockType.menuIcon.value
                }}</span>
                <span>插入{{ blockType.title }}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuPortal>
        </ContextMenuSub>
        <ContextMenuSeparator class="editor-context-menu__separator" />
        <ContextMenuItem class="editor-context-menu__item" @select="copyContextBlock">
          <CopyPlus :size="15" /><span>复制当前块</span>
          <small>{{ settings.blockCopyBehavior === 'duplicate' ? '下方重复' : '保留' }}</small>
        </ContextMenuItem>
        <ContextMenuItem
          class="editor-context-menu__item"
          :disabled="!retainedBlockAvailable"
          @select="pasteRetainedBlock"
        >
          <ClipboardPaste :size="15" /><span>粘贴块</span>
        </ContextMenuItem>
        <ContextMenuItem
          class="editor-context-menu__item editor-context-menu__item--danger"
          @select="deleteContextBlock"
        >
          <Trash2 :size="15" /><span>删除当前块</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
