import { Blockquote } from '@tiptap/extension-blockquote'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { Color } from '@tiptap/extension-color'
import { Heading } from '@tiptap/extension-heading'
import { Highlight } from '@tiptap/extension-highlight'
import { HorizontalRule } from '@tiptap/extension-horizontal-rule'
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { TextAlign } from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import { UniqueID } from '@tiptap/extension-unique-id'
import { StarterKit } from '@tiptap/starter-kit'
import { VueNodeViewRenderer, type Extensions } from '@tiptap/vue-3'
import { common, createLowlight } from 'lowlight'

import { BLOCK_ID_ATTRIBUTE, BLOCK_ID_NODE_TYPES, generateBlockId } from '@/editor/blocks/blockId'
import { AttachmentBlock } from '@/editor/blocks/attachmentBlock'
import { BlockControls } from '@/editor/blocks/blockControls'
import BlockContainerNodeView from '@/editor/components/BlockContainerNodeView.vue'
import CodeBlockNodeView from '@/editor/components/CodeBlockNodeView.vue'
import { CollapsibleBlock } from '@/editor/blocks/collapsibleBlock'
import HorizontalRuleNodeView from '@/editor/components/HorizontalRuleNodeView.vue'
import { HEADING_LEVELS } from '@/editor/core/headingLevels'
import { ImageFigure } from '@/editor/blocks/imageFigure'
import { SlashCommand } from '@/editor/commands/slashCommand'
import { SubscriptMark, SuperscriptMark } from '@/editor/formatting/scriptMarks'
import { MathBlock, TableBlock } from '@/editor/blocks/structuredBlocks'
import type { AssetPort } from '@/services/ports/AssetPort'

const lowlight = createLowlight(common)

export function createEditorExtensions(assetPort: AssetPort | null = null): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      paragraph: false,
      link: {
        autolink: true,
        defaultProtocol: 'https',
        openOnClick: false,
        protocols: ['file'],
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      },
    }),
    Paragraph.extend({
      addNodeView() {
        return VueNodeViewRenderer(BlockContainerNodeView)
      },
    }),
    Heading.extend({
      addNodeView() {
        return VueNodeViewRenderer(BlockContainerNodeView, {
          update: ({ oldNode, newNode, updateProps }) => {
            if (oldNode.type !== newNode.type || oldNode.attrs.level !== newNode.attrs.level) {
              return false
            }

            updateProps()
            return true
          },
        })
      },
    }).configure({
      levels: [...HEADING_LEVELS],
    }),
    Blockquote.extend({
      addNodeView() {
        return VueNodeViewRenderer(BlockContainerNodeView)
      },
    }),
    BulletList.extend({
      addNodeView() {
        return VueNodeViewRenderer(BlockContainerNodeView)
      },
    }),
    OrderedList.extend({
      addNodeView() {
        return VueNodeViewRenderer(BlockContainerNodeView)
      },
    }),
    ListItem,
    ListKeymap,
    TaskList.extend({
      addNodeView() {
        return VueNodeViewRenderer(BlockContainerNodeView)
      },
    }),
    TaskItem.configure({
      nested: true,
    }),
    HorizontalRule.extend({
      addNodeView() {
        return VueNodeViewRenderer(HorizontalRuleNodeView)
      },
    }),
    CodeBlockLowlight.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          title: {
            default: '',
            parseHTML: (element) => element.getAttribute('data-code-title') ?? '',
            renderHTML: (attributes) => {
              if (!attributes.title) {
                return {}
              }

              return {
                'data-code-title': attributes.title,
              }
            },
          },
          wrap: {
            default: true,
            parseHTML: (element) => element.getAttribute('data-code-wrap') !== 'false',
            renderHTML: (attributes) => ({
              'data-code-wrap': attributes.wrap === false ? 'false' : 'true',
            }),
          },
        }
      },
      addNodeView() {
        return VueNodeViewRenderer(CodeBlockNodeView)
      },
    }).configure({
      lowlight,
      defaultLanguage: 'plaintext',
      languageClassPrefix: 'language-',
      HTMLAttributes: {
        class: 'code-block-node',
        spellcheck: 'false',
      },
    }),
    ImageFigure.configure({ assetPort }),
    AttachmentBlock.configure({ assetPort }),
    TableBlock,
    MathBlock,
    CollapsibleBlock,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    SubscriptMark,
    SuperscriptMark,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
      alignments: ['left', 'center', 'right'],
    }),
    Placeholder.configure({
      placeholder: ({ node }) => {
        if (node.type.name === 'heading') {
          return '标题'
        }

        return '输入 / 插入块'
      },
      showOnlyWhenEditable: true,
      includeChildren: true,
    }),
    UniqueID.configure({
      attributeName: BLOCK_ID_ATTRIBUTE,
      types: [...BLOCK_ID_NODE_TYPES],
      generateID: generateBlockId,
    }),
    BlockControls,
    SlashCommand,
  ]
}
