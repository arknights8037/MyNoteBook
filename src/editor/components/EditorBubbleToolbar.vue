<script setup lang="ts">
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Highlighter,
  Italic,
  Link,
  Palette,
  Redo2,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2,
} from '@lucide/vue'
import type { Editor } from '@tiptap/vue-3'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import { computed, watch } from 'vue'

import {
  HIGHLIGHT_COLOR_SWATCHES,
  TEXT_COLOR_SWATCHES,
  useEditorColorFormatting,
} from '@/editor/composables/useEditorColorFormatting'
import { shouldShowEditorBubbleMenu } from '@/editor/core/editorBubbleMenu'
import { NButton, NButtonGroup, NIcon, NTooltip } from '@/ui'
import EditorColorPickerPopover from './EditorColorPickerPopover.vue'

const props = defineProps<{ editor: Editor; readonly: boolean }>()
const editorRef = computed(() => props.editor)
const {
  textColor,
  highlightColor,
  recentTextColors,
  recentHighlightColors,
  colorPopoverOpen,
  highlightPopoverOpen,
  setTextColor,
  previewTextColor,
  setHighlightColor,
  previewHighlightColor,
  unsetTextColor,
  unsetHighlightColor,
  syncTextColor,
  syncHighlightColor,
  hasActiveTextColor,
  hasActiveHighlight,
} = useEditorColorFormatting(editorRef)

const menuOptions = {
  strategy: 'fixed' as const,
  placement: 'top' as const,
  offset: 10,
  flip: true,
  shift: { padding: 14 },
  inline: true,
}
const alignments = [
  { value: 'left', label: '左对齐', icon: AlignLeft },
  { value: 'center', label: '居中对齐', icon: AlignCenter },
  { value: 'right', label: '右对齐', icon: AlignRight },
] as const

watch(
  () => props.editor,
  (editor, _previous, onCleanup) => {
    const sync = (): void => {
      syncTextColor(editor)
      syncHighlightColor(editor)
    }
    sync()
    editor.on('selectionUpdate', sync)
    editor.on('update', sync)
    onCleanup(() => {
      editor.off('selectionUpdate', sync)
      editor.off('update', sync)
    })
  },
  { immediate: true },
)

function shouldShow({ editor, from, to }: { editor: Editor; from: number; to: number }): boolean {
  return shouldShowEditorBubbleMenu({
    editor,
    from,
    to,
    readonly: props.readonly,
    keepOpen: colorPopoverOpen.value || highlightPopoverOpen.value,
  })
}

function isActive(name: string, attributes?: Record<string, unknown>): boolean {
  return props.editor.isActive(name, attributes)
}

function setLink(): void {
  const currentHref = getCurrentLinkHref(props.editor)
  const href = globalThis.prompt('输入链接地址', currentHref)
  if (href === null) return void props.editor.commands.focus()
  if (href.trim() === '') {
    props.editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  props.editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
}

function getCurrentLinkHref(editor: Editor): string {
  const attributes = editor.getAttributes('link')
  return typeof attributes === 'object' && attributes && typeof attributes.href === 'string'
    ? attributes.href
    : ''
}

function isTextAligned(alignment: 'left' | 'center' | 'right'): boolean {
  return props.editor.isActive({ textAlign: alignment })
}

function getBubbleMenuContainer(): InstanceType<typeof globalThis.HTMLElement> {
  return globalThis.document.body
}
</script>

<template>
  <BubbleMenu
    class="bubble-menu-layer"
    :editor="editor"
    :should-show="shouldShow"
    :append-to="getBubbleMenuContainer"
    :options="menuOptions"
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
            @click="editor.chain().focus().toggleBold().run()"
          >
            <template #icon
              ><NIcon :size="16"><Bold /></NIcon
            ></template>
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
            @click="editor.chain().focus().toggleItalic().run()"
          >
            <template #icon
              ><NIcon :size="16"><Italic /></NIcon
            ></template>
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
            @click="editor.chain().focus().toggleStrike().run()"
          >
            <template #icon
              ><NIcon :size="16"><Strikethrough /></NIcon
            ></template>
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
            @click="editor.chain().focus().toggleUnderline().run()"
          >
            <template #icon
              ><NIcon :size="16"><Underline /></NIcon
            ></template>
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
            @click="editor.chain().focus().toggleCode().run()"
          >
            <template #icon
              ><NIcon :size="16"><Code /></NIcon
            ></template>
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
            @click="editor.chain().focus().toggleMark('subscript').run()"
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
            @click="editor.chain().focus().toggleMark('superscript').run()"
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
            <template #icon
              ><NIcon :size="16"><Link /></NIcon
            ></template>
          </NButton>
        </template>
        链接
      </NTooltip>
      <span class="bubble-toolbar__separator" aria-hidden="true"></span>
      <EditorColorPickerPopover
        v-model:show="colorPopoverOpen"
        v-model:value="textColor"
        :recent-colors="recentTextColors"
        :swatches="TEXT_COLOR_SWATCHES"
        :active="hasActiveTextColor()"
        label="文字颜色"
        recent-swatch-label="设置最近使用的文字颜色"
        swatch-label="设置文字颜色"
        recent-aria-label="最近使用的文字颜色"
        swatches-aria-label="常用文字颜色"
        clear-label="清除颜色"
        @preview="previewTextColor"
        @change="setTextColor"
        @clear="unsetTextColor"
      >
        <template #icon><Palette /></template>
      </EditorColorPickerPopover>
      <EditorColorPickerPopover
        v-model:show="highlightPopoverOpen"
        v-model:value="highlightColor"
        :recent-colors="recentHighlightColors"
        :swatches="HIGHLIGHT_COLOR_SWATCHES"
        :active="hasActiveHighlight()"
        label="荧光笔"
        recent-swatch-label="设置最近使用的高亮颜色"
        swatch-label="设置高亮颜色"
        recent-aria-label="最近使用的高亮颜色"
        swatches-aria-label="常用高亮颜色"
        clear-label="清除高亮"
        @preview="previewHighlightColor"
        @change="setHighlightColor"
        @clear="unsetHighlightColor"
      >
        <template #icon><Highlighter /></template>
      </EditorColorPickerPopover>
      <span class="bubble-toolbar__separator" aria-hidden="true"></span>
      <NTooltip v-for="alignment in alignments" :key="alignment.value" trigger="hover">
        <template #trigger>
          <NButton
            class="bubble-toolbar__button"
            :class="{ 'bubble-toolbar__button--active': isTextAligned(alignment.value) }"
            size="small"
            quaternary
            circle
            :aria-label="alignment.label"
            @mousedown.prevent
            @click="editor.chain().focus().setTextAlign(alignment.value).run()"
          >
            <template #icon>
              <NIcon :size="16">
                <component :is="alignment.icon" />
              </NIcon>
            </template>
          </NButton>
        </template>
        {{ alignment.label }}
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
            @click="editor.chain().focus().undo().run()"
          >
            <template #icon
              ><NIcon :size="16"><Undo2 /></NIcon
            ></template>
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
            @click="editor.chain().focus().redo().run()"
          >
            <template #icon
              ><NIcon :size="16"><Redo2 /></NIcon
            ></template>
          </NButton>
        </template>
        重做
      </NTooltip>
    </NButtonGroup>
  </BubbleMenu>
</template>
