<script setup lang="ts">
import 'katex/dist/katex.min.css'

import {
  ClipboardPaste,
  Code,
  CopyPlus,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  ImagePlus,
  Link,
  Quote,
  Redo2,
  Table2,
  Trash2,
  Undo2,
  Sigma,
} from '@lucide/vue'
import { EditorContent, type Editor, type JSONContent, useEditor } from '@tiptap/vue-3'
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
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { createEditorExtensions } from '@/editor/core/createEditorExtensions'
import {
  cloneBlockForInsertion,
  hasRetainedBlock,
  retainBlock,
  takeRetainedBlock,
} from '@/editor/commands/blockClipboard'
import { ensureTopLevelBlockIds } from '@/editor/blocks/blockId'
import {
  CONTEXT_INSERT_BLOCK_TYPES,
  TRANSFORM_BLOCK_TYPES,
  getContextInsertContent,
  type BlockMenuIcon,
  type RegisteredBlockType,
} from '@/editor/blocks/blockTypeRegistry'
import { isSameEditorContent, normalizeEditorContent } from '@/editor/core/editorContent'
import { parseMarkdownDocument } from '@/editor/io/markdownImport'
import {
  exportTiptapBlockToMarkdown,
  exportTiptapDocumentToMarkdown,
} from '@/editor/io/documentExport'
import { useEditorJumpAid } from '@/editor/composables/useEditorJumpAid'
import {
  getClipboardImageFile,
  useEditorAssetInsertion,
} from '@/editor/composables/useEditorAssetInsertion'
import EditorBubbleToolbar from '@/editor/components/EditorBubbleToolbar.vue'
import { ASSET_PORT_KEY } from '@/editor/core/assetPortContext'
import { shouldShowEditorBubbleMenu } from '@/editor/core/editorBubbleMenu'
import type { SelectedBlock } from '@/models/agent/agent'
import {
  createInternalDocumentHref,
  isLocalDocumentHref,
  parseInternalDocumentHref,
  resolveLocalDocumentHref,
} from '@/models/documents/documentLink'
import type { TiptapDocumentJson } from '@/models/documents/document'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@/models/settings/settings'
import type { AssetPort } from '@/services/ports/AssetPort'

const props = withDefaults(
  defineProps<{
    modelValue?: TiptapDocumentJson
    readonly?: boolean
    autofocus?: boolean
    ariaLabel?: string
    settings?: AppSettings
    internalDocuments?: Array<{ id: string; title: string; sourceUrl?: string }>
    documentId?: string
    assetPort?: AssetPort
  }>(),
  {
    modelValue: undefined,
    readonly: false,
    autofocus: false,
    ariaLabel: '文档编辑器',
    settings: () => ({ ...DEFAULT_APP_SETTINGS }),
    internalDocuments: () => [],
    documentId: '',
    assetPort: undefined,
  },
)

const editorAssetPort = props.assetPort ?? inject(ASSET_PORT_KEY, null)

const emit = defineEmits<{
  'update:modelValue': [value: TiptapDocumentJson]
  textUpdate: [value: string]
  ready: []
  destroy: []
  imageError: [message: string]
  openDocument: [documentId: string, blockId?: string]
  unresolvedDocumentLink: [href: string]
}>()

const initialContent = computed(() =>
  ensureTopLevelBlockIds(normalizeEditorContent(props.modelValue)),
)
const editorShellElement = ref<InstanceType<typeof globalThis.HTMLElement> | null>(null)
const contextBlockPosition = ref<number | null>(null)
const retainedBlockAvailable = ref(hasRetainedBlock())
const editorRevision = ref(0)
const editorAppearanceStyle = computed(() => ({
  '--editor-content-width': { compact: '720px', standard: '850px', wide: '1000px' }[
    props.settings.contentWidth
  ],
  '--editor-font-size': { small: '14px', standard: '16px', large: '18px' }[props.settings.fontSize],
  '--editor-line-height': { compact: '1.5', comfortable: '1.72', relaxed: '2' }[
    props.settings.lineHeight
  ],
  '--editor-western-font-family': toCssFontFamily(props.settings.westernFontFamily),
  '--editor-chinese-font-family': toCssFontFamily(props.settings.chineseFontFamily),
}))
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

interface EditorBlockSnapshot extends SelectedBlock {
  from: number
  to: number
  json: JSONContent
}

const editor = useEditor({
  content: initialContent.value,
  editable: !props.readonly,
  autofocus: props.autofocus,
  extensions: createEditorExtensions(editorAssetPort),
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
  onCreate: () => {
    editorRevision.value += 1
    emit('ready')
  },
  onUpdate: ({ editor: activeEditor }) => {
    editorRevision.value += 1
    emit('update:modelValue', activeEditor.getJSON() as TiptapDocumentJson)
    emit('textUpdate', activeEditor.getText())
  },
})

const {
  imageFileInput,
  attachmentFileInput,
  insertImage,
  insertAttachment,
  handleImageFileChange,
  handleAttachmentFileChange,
  insertImageFile,
} = useEditorAssetInsertion({
  editor,
  assetPort: editorAssetPort,
  documentId: () => props.documentId,
  reportError: (message) => emit('imageError', message),
})

const {
  activeItemId: activeJumpAidItemId,
  items: jumpAidItems,
  position: jumpAidPosition,
  visible: showJumpAid,
  jumpToBlock,
  revealBlock,
  scheduleSync: scheduleActiveJumpAidSync,
} = useEditorJumpAid({
  editor,
  content: () => props.modelValue,
  revision: editorRevision,
  settings: () => props.settings,
  scrollContainer: editorShellElement,
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
  return shouldShowEditorBubbleMenu({
    editor: activeEditor,
    from,
    to,
    readonly: props.readonly,
  })
}

function undo(): void {
  editor.value?.chain().focus().undo().run()
}

function insertMarkdown(markdown: string): void {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable || !markdown.trim()) return
  const parsed = parseMarkdownDocument(markdown, 'AI 输出')
  const content = parsed.content.content ?? [{ type: 'paragraph' }]
  activeEditor.chain().focus().insertContent(content).run()
}

function getCurrentDocumentBlocks(): EditorBlockSnapshot[] {
  const activeEditor = editor.value
  if (!activeEditor) return []

  const blocks: EditorBlockSnapshot[] = []
  activeEditor.state.doc.forEach((node, offset, index) => {
    const id = isRecord(node.attrs) ? String(node.attrs.id ?? '') : ''
    if (!id) return

    const json = node.toJSON()
    blocks.push({
      id,
      type: node.type.name,
      text: node.textBetween(0, node.content.size, '\n').trim(),
      markdown: exportTiptapBlockToMarkdown(json),
      index,
      from: offset,
      to: offset + node.nodeSize,
      json,
    })
  })
  return blocks
}

function getDocumentMarkdown(): string {
  const content = editor.value?.getJSON() as TiptapDocumentJson | undefined
  return content ? exportTiptapDocumentToMarkdown(content) : ''
}

function getSelectedBlocks(): EditorBlockSnapshot[] {
  const activeEditor = editor.value
  if (!activeEditor) return []

  const { from, to, empty } = activeEditor.state.selection
  const blocks = getCurrentDocumentBlocks()
  if (empty) {
    return blocks.filter((block) => from >= block.from && from <= block.to).slice(0, 1)
  }

  return blocks.filter((block) => block.to >= from && block.from <= to)
}

function replaceBlocksWithMarkdown(blockIds: string[], markdown: string): boolean {
  const activeEditor = editor.value
  if (!activeEditor || !activeEditor.isEditable || blockIds.length === 0 || !markdown.trim()) {
    return false
  }

  const targetIds = new Set(blockIds)
  const targetBlocks = getCurrentDocumentBlocks().filter((block) => targetIds.has(block.id))
  if (targetBlocks.length === 0) return false

  const parsed = parseMarkdownDocument(markdown, 'AI 输出')
  const content = parsed.content.content ?? [{ type: 'paragraph' }]
  const from = Math.min(...targetBlocks.map((block) => block.from))
  const to = Math.max(...targetBlocks.map((block) => block.to))

  activeEditor.chain().focus().insertContentAt({ from, to }, content).run()
  return true
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
  const targetDocument =
    parseInternalDocumentHref(href) ?? resolveLocalDocumentHref(href, props.internalDocuments)
  if (!targetDocument) {
    if (isLocalDocumentHref(href)) {
      event.preventDefault()
      emit('unresolvedDocumentLink', href)
    }
    return
  }

  event.preventDefault()
  if (targetDocument.blockId)
    emit('openDocument', targetDocument.documentId, targetDocument.blockId)
  else emit('openDocument', targetDocument.documentId)
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
  const href = createInternalDocumentHref(target.id)

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

function toCssFontFamily(value: string): string {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace)$/i.test(
        part,
      )
        ? part
        : `"${part.replace(/["\\]/g, '')}"`,
    )
    .join(', ')
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
    void nextTick(scheduleActiveJumpAidSync)
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
  getDocumentMarkdown,
  getCurrentDocumentBlocks,
  getSelectedBlocks,
  hasBlockSelection: () => Boolean(editor.value && !editor.value.state.selection.empty),
  focus: () => editor.value?.commands.focus(),
  undo,
  insertImage,
  insertAttachment,
  insertMarkdown,
  replaceBlocksWithMarkdown,
  revealBlock,
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
        ref="editorShellElement"
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
        <EditorBubbleToolbar v-if="editor" :editor="editor" :readonly="readonly" />
        <nav
          v-if="showJumpAid"
          class="editor-jump-aid"
          :class="[`editor-jump-aid--${settings.jumpAid}`, `editor-jump-aid--${jumpAidPosition}`]"
          aria-label="文档跳转辅助"
        >
          <button
            v-for="item in jumpAidItems"
            :key="item.id"
            type="button"
            class="editor-jump-aid__item"
            :class="[
              `editor-jump-aid__item--level-${item.level}`,
              { 'editor-jump-aid__item--active': item.id === activeJumpAidItemId },
            ]"
            :title="item.title"
            @click="jumpToBlock(item)"
          >
            <span class="editor-jump-aid__dot" aria-hidden="true"></span>
            <span v-if="settings.jumpAid === 'outline'" class="editor-jump-aid__label">{{
              item.title
            }}</span>
          </button>
        </nav>
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
