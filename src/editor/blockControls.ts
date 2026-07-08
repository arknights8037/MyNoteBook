import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { Extension, type Editor, type JSONContent } from '@tiptap/vue-3'
import { DragGesture } from '@use-gesture/vanilla'

import { BLOCK_ID_ATTRIBUTE } from './blockId'
import { getBlockIndentAttributes, INDENT_ATTRIBUTE, normalizeIndentLevel } from './blockIndent'
import { TRANSFORM_BLOCK_TYPES } from './blockTypeRegistry'

const BlockControlsPluginKey = new PluginKey<BlockControlsState>('block-controls')

interface BlockControlsState {
  draggingRange: BlockRange | null
  isFocused: boolean
}

interface TopLevelBlock {
  node: ProseMirrorNode
  pos: number
}

export interface BlockRange {
  from: number
  to: number
}

interface BlockClientRect {
  top: number
  bottom: number
  left: number
  width: number
  height: number
}

interface BlockControlsFocusMeta {
  isFocused: boolean
}

let activeMenu: HTMLElement | null = null
let removeOutsideListener: (() => void) | null = null
const PRESSED_BLOCK_CLASS = 'editor-block--pressed'
const PRESSED_HANDLE_CLASS = 'block-control-handle--pressed'
const DRAGGING_BLOCK_CLASS = 'editor-block--dragging'
const DRAG_LIVE_BLOCK_CLASS = 'editor-block--drag-live'
const DRAGGING_HANDLE_CLASS = 'block-control-handle--dragging'
const BLOCK_CONTROL_GUTTER_LEFT = 44
const BLOCK_CONTROL_HANDLE_WIDTH = 24

interface ActiveDrag {
  range: BlockRange
  lastClientX: number
  lastClientY: number
  blockElements: HTMLElement[]
  dropIndicator: HTMLElement | null
  initialTrailingEmptyParagraphCount: number
  previewFrame: number
}

interface DragGestureState {
  active: boolean
  first: boolean
  last: boolean
  intentional: boolean
  movement: [number, number]
  tap: boolean
  xy: [number, number]
  event: Event
}

let activeDrag: ActiveDrag | null = null
let pressedRange: BlockRange | null = null

export const BlockControls = Extension.create({
  name: 'blockControls',

  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'bulletList',
          'orderedList',
          'taskList',
          'blockquote',
          'codeBlock',
          'horizontalRule',
          'imageFigure',
          'attachmentBlock',
          'tableBlock',
          'mathBlock',
          'collapsibleBlock',
        ],
        attributes: {
          [INDENT_ATTRIBUTE]: {
            default: 0,
            parseHTML: (element) => normalizeIndentLevel(element.getAttribute('data-indent-level')),
            renderHTML: (attributes) => {
              const indentLevel = normalizeIndentLevel(attributes[INDENT_ATTRIBUTE])

              return getBlockIndentAttributes(indentLevel)
            },
          },
        },
      },
    ]
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => indentSelectedBlock(this.editor, 1),
      'Shift-Tab': () => indentSelectedBlock(this.editor, -1),
      Backspace: () => outdentIndentedBlockOnBackspace(this.editor),
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor

    return [
      new Plugin<BlockControlsState>({
        key: BlockControlsPluginKey,
        state: {
          init: () => ({ draggingRange: null, isFocused: false }),
          apply: (transaction, value) => {
            const meta = transaction.getMeta(BlockControlsPluginKey) as
              | BlockRange
              | BlockControlsFocusMeta
              | null
              | undefined

            if (isBlockControlsFocusMeta(meta)) {
              return {
                ...value,
                isFocused: meta.isFocused,
              }
            }

            if (meta !== undefined) {
              return {
                ...value,
                draggingRange: meta,
              }
            }

            if (value.draggingRange === null) {
              return value
            }

            return {
              draggingRange: {
                from: transaction.mapping.map(value.draggingRange.from),
                to: transaction.mapping.map(value.draggingRange.to),
              },
              isFocused: value.isFocused,
            }
          },
        },
        props: {
          decorations(state) {
            const decorations: Decoration[] = []

            state.doc.forEach((node, pos) => {
              if (!isControllableBlock(node)) {
                return
              }

              const attributes: Record<string, string> = {
                class: 'editor-block',
                'data-editor-block-pos': String(pos),
              }
              const blockId = getBlockId(node)
              if (blockId) {
                attributes['data-editor-block-id'] = blockId
              }

              decorations.push(Decoration.node(pos, pos + node.nodeSize, attributes))
            })

            const pluginState = BlockControlsPluginKey.getState(state)
            const activeBlock = pluginState?.isFocused ? getTopLevelBlockAtSelection(state) : null
            if (activeBlock) {
              decorations.push(
                Decoration.node(activeBlock.pos, activeBlock.pos + activeBlock.node.nodeSize, {
                  class: 'editor-block--selected',
                }),
              )
            }

            const draggingRange = pluginState?.draggingRange
            if (draggingRange) {
              for (const block of getTopLevelBlocksInRange(
                state,
                draggingRange.from,
                draggingRange.to,
              )) {
                decorations.push(
                  Decoration.node(block.pos, block.pos + block.node.nodeSize, {
                    class: DRAGGING_BLOCK_CLASS,
                  }),
                )
              }
            }

            return DecorationSet.create(state.doc, decorations)
          },
        },
        view(view) {
          return createBlockControlsView(editor, view)
        },
      }),
    ]
  },
})

function createBlockControlsView(editor: Editor, view: EditorView) {
  const scrollContainer = view.dom.closest('.editor-shell') as HTMLElement | null
  const overlay = globalThis.document.createElement('div')
  overlay.className = 'block-controls-overlay'
  const dropIndicator = globalThis.document.createElement('div')
  dropIndicator.className = 'block-drop-indicator'

  if (scrollContainer) {
    scrollContainer.append(overlay)
    scrollContainer.append(dropIndicator)
  }

  let updateFrame = 0

  const update = (): void => {
    updateFrame = 0

    if (activeDrag) {
      return
    }

    renderBlockHandles(editor, view, overlay, scrollContainer)
  }

  const scheduleUpdate = (): void => {
    if (updateFrame !== 0) {
      return
    }

    updateFrame = globalThis.requestAnimationFrame(update)
  }

  scheduleUpdate()
  scrollContainer?.addEventListener('scroll', scheduleUpdate)
  scrollContainer?.addEventListener('focusin', handleEditorFocusIn)
  scrollContainer?.addEventListener('focusout', handleEditorFocusOut)
  globalThis.document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  globalThis.addEventListener('resize', scheduleUpdate)

  function handleEditorFocusIn(): void {
    setBlockControlsFocused(view, true)
  }

  function handleEditorFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget
    if (
      scrollContainer &&
      nextTarget instanceof globalThis.Node &&
      scrollContainer.contains(nextTarget)
    ) {
      return
    }

    setBlockControlsFocused(view, false)
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    const target = event.target
    if (!(target instanceof globalThis.Node)) {
      return
    }

    if (isEditorInteractionTarget(view, target)) {
      return
    }

    blurEditorCompletely(view)
  }

  return {
    update: scheduleUpdate,
    destroy() {
      if (updateFrame !== 0) {
        globalThis.cancelAnimationFrame(updateFrame)
      }
      if (activeDrag?.previewFrame) {
        globalThis.cancelAnimationFrame(activeDrag.previewFrame)
        activeDrag = null
      }

      closeBlockTransformMenu()
      clearPressedBlockRange(view)
      scrollContainer?.removeEventListener('scroll', scheduleUpdate)
      scrollContainer?.removeEventListener('focusin', handleEditorFocusIn)
      scrollContainer?.removeEventListener('focusout', handleEditorFocusOut)
      globalThis.document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
      globalThis.removeEventListener('resize', scheduleUpdate)
      overlay.remove()
      dropIndicator.remove()
    },
  }
}

function isBlockControlsFocusMeta(value: unknown): value is BlockControlsFocusMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isFocused' in value &&
    typeof (value as BlockControlsFocusMeta).isFocused === 'boolean'
  )
}

function setBlockControlsFocused(view: EditorView, isFocused: boolean): void {
  const pluginState = BlockControlsPluginKey.getState(view.state)
  if (pluginState?.isFocused === isFocused) {
    return
  }

  view.dispatch(
    view.state.tr.setMeta(BlockControlsPluginKey, { isFocused }).setMeta('addToHistory', false),
  )
}

function isEditorInteractionTarget(view: EditorView, target: Node): boolean {
  if (view.dom.contains(target)) {
    return true
  }

  const element = target instanceof globalThis.Element ? target : (target.parentElement ?? null)
  if (!element) {
    return false
  }

  return Boolean(
    element.closest(
      [
        '.block-control-handle',
        '.block-transform-menu',
        '.bubble-menu-layer',
        '.bubble-color-panel',
        '.editor-context-menu',
      ].join(','),
    ),
  )
}

function blurEditorCompletely(view: EditorView): void {
  let transaction = view.state.tr
  const { selection } = view.state

  if (!selection.empty || selection instanceof NodeSelection) {
    const position = Math.max(0, Math.min(selection.to, view.state.doc.content.size))
    transaction = transaction.setSelection(TextSelection.near(view.state.doc.resolve(position), 1))
  }

  transaction = transaction
    .setMeta(BlockControlsPluginKey, { isFocused: false })
    .setMeta('addToHistory', false)

  if (
    transaction.docChanged ||
    transaction.selectionSet ||
    transaction.getMeta(BlockControlsPluginKey)
  ) {
    view.dispatch(transaction)
  }

  view.dom.blur()
  globalThis.getSelection()?.removeAllRanges()
}

function renderBlockHandles(
  editor: Editor,
  view: EditorView,
  overlay: HTMLElement,
  scrollContainer: HTMLElement | null,
): void {
  overlay.replaceChildren()

  if (!scrollContainer || !editor.isEditable) {
    return
  }

  view.state.doc.forEach((node, pos) => {
    if (!isControllableBlock(node)) {
      return
    }

    const blockElement = getBlockElement(view, pos)
    if (!blockElement) {
      return
    }

    const handle = createBlockHandle(editor, view, pos)
    const blockRect = blockElement.getBoundingClientRect()
    const containerRect = scrollContainer.getBoundingClientRect()

    handle.style.top = `${blockRect.top - containerRect.top + scrollContainer.scrollTop + getHandleTopOffset(blockElement)}px`
    handle.style.left = `${blockRect.left - containerRect.left + scrollContainer.scrollLeft + getHandleLeftOffset()}px`

    overlay.append(handle)
  })
}

function createBlockHandle(editor: Editor, view: EditorView, pos: number): HTMLElement {
  const handle = document.createElement('button')
  handle.type = 'button'
  handle.draggable = false
  handle.className = 'block-control-handle'
  handle.setAttribute('aria-label', '拖拽或转换块')
  handle.title = '拖拽排序，点击转换'
  handle.innerHTML =
    '<span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>'
  let didDrag = false
  let isPointerDown = false
  let pointerDownRect: DOMRect | null = null

  const clearPressedState = (): void => {
    isPointerDown = false
    handle.classList.remove(PRESSED_HANDLE_CLASS)
    clearPressedBlockRange(view)
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    didDrag = false
    isPointerDown = true
    pointerDownRect = handle.getBoundingClientRect()
    handle.classList.add(PRESSED_HANDLE_CLASS)
    pressedRange = getMovableBlockRange(editor.state, pos)
    addBlockRangeDomClass(view, pressedRange, PRESSED_BLOCK_CLASS)
  })

  handle.addEventListener('pointerup', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const anchorRect = pointerDownRect ?? handle.getBoundingClientRect()

    clearPressedState()

    if (didDrag || activeDrag) {
      return
    }

    selectBlock(editor, pos)
    showBlockTransformMenu(editor, pos, anchorRect)
  })

  handle.addEventListener('pointercancel', () => {
    clearPressedState()
  })

  handle.addEventListener('mouseleave', () => {
    if (!activeDrag && !isPointerDown) {
      clearPressedState()
    }
  })

  handle.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  handle.addEventListener('dragstart', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  new DragGesture(
    handle,
    (state: DragGestureState) => {
      preventDragDefault(state.event)

      if (state.tap && state.last) {
        clearPressedState()
        return
      }

      if (!state.intentional && !activeDrag) {
        return
      }

      if (!activeDrag) {
        const dragRange = getMovableBlockRange(editor.state, pos)
        didDrag = true
        activeDrag = {
          range: dragRange,
          lastClientX: state.xy[0],
          lastClientY: state.xy[1],
          blockElements: [],
          dropIndicator: null,
          initialTrailingEmptyParagraphCount: countTrailingEmptyParagraphs(editor.state),
          previewFrame: 0,
        }
        closeBlockTransformMenu()
        clearPressedState()
        selectBlock(editor, pos)
        activeDrag.blockElements = getBlockRangeDomElements(view, dragRange)
        activeDrag.dropIndicator = getDropIndicatorElement(view)
        applyDraggingDomState(activeDrag.blockElements, true)
        handle.classList.add(DRAGGING_HANDLE_CLASS)
        editor.view.dispatch(editor.view.state.tr.setMeta(BlockControlsPluginKey, dragRange))
      }

      if (state.active && activeDrag) {
        if (!activeDrag) {
          return
        }

        activeDrag.lastClientX = state.xy[0]
        activeDrag.lastClientY = state.xy[1]
        scheduleActiveDragPreview(view)
        handle.style.transform = `translate(${state.movement[0]}px, ${state.movement[1]}px)`
      }

      if (state.last) {
        const drag = activeDrag
        let movedRange: BlockRange | null = null
        activeDrag = null
        clearPressedState()
        if (drag) {
          drag.lastClientX = state.xy[0]
          drag.lastClientY = state.xy[1]
          if (drag.previewFrame !== 0) {
            globalThis.cancelAnimationFrame(drag.previewFrame)
            drag.previewFrame = 0
          }
          applyDraggingDomState(drag.blockElements, false)
          hideDropIndicator(drag.dropIndicator)
          movedRange = moveBlockRangeAtPoint(
            editor,
            view,
            drag.range.from,
            drag.lastClientX,
            drag.lastClientY,
          )
          if (movedRange) {
            trimExcessTrailingEmptyParagraphs(view, drag.initialTrailingEmptyParagraphCount)
          }
        }
        handle.classList.remove(DRAGGING_HANDLE_CLASS)
        handle.style.transform = ''

        editor.view.dispatch(
          editor.view.state.tr
            .setMeta(BlockControlsPluginKey, null)
            .setMeta('block-controls-drag-refresh', Date.now()),
        )
        forceDragEndDomRefresh(view)

        globalThis.setTimeout(() => {
          didDrag = false
        }, 0)
      }
    },
    {
      axis: 'y',
      eventOptions: {
        passive: false,
      },
      filterTaps: true,
      pointer: {
        capture: true,
      },
    },
  )

  return handle
}

function preventDragDefault(event: Event): void {
  if (event.cancelable) {
    event.preventDefault()
  }

  event.stopPropagation()
}

function scheduleActiveDragPreview(view: EditorView): void {
  if (!activeDrag || activeDrag.previewFrame !== 0) {
    return
  }

  activeDrag.previewFrame = globalThis.requestAnimationFrame(() => {
    updateActiveDragPreview(view)
  })
}

function updateActiveDragPreview(view: EditorView): void {
  const drag = activeDrag
  if (!drag) {
    return
  }

  drag.previewFrame = 0
  updateDropIndicator(view, drag, drag.lastClientX, drag.lastClientY)
}

function getHandleTopOffset(blockElement: HTMLElement): number {
  return Math.max(blockElement.getBoundingClientRect().height * 0.5 - 14, 0)
}

function getHandleLeftOffset(): number {
  return Math.max((BLOCK_CONTROL_GUTTER_LEFT - BLOCK_CONTROL_HANDLE_WIDTH) * 0.5, 0)
}

function showBlockTransformMenu(editor: Editor, pos: number, anchorRect: DOMRect): void {
  closeBlockTransformMenu()

  const menu = document.createElement('div')
  menu.className = 'block-transform-menu'
  menu.setAttribute('role', 'menu')

  for (const blockType of TRANSFORM_BLOCK_TYPES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'block-transform-menu__item'
    button.setAttribute('role', 'menuitem')

    const shortcut = document.createElement('span')
    shortcut.className = 'block-transform-menu__shortcut'
    shortcut.textContent = blockType.slashIcon

    const label = document.createElement('span')
    label.className = 'block-transform-menu__label'
    label.textContent = blockType.title

    button.append(shortcut, label)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      focusInsideBlock(editor, pos)
      blockType.transform?.(editor)
      closeBlockTransformMenu()
    })

    menu.append(button)
  }

  document.body.append(menu)
  activeMenu = menu

  positionFloatingMenu(menu, anchorRect)

  const outsideListener = (event: MouseEvent) => {
    if (menu.contains(event.target as Node)) {
      return
    }

    closeBlockTransformMenu()
  }

  document.addEventListener('mousedown', outsideListener)
  removeOutsideListener = () => document.removeEventListener('mousedown', outsideListener)
}

function closeBlockTransformMenu(): void {
  activeMenu?.remove()
  activeMenu = null
  removeOutsideListener?.()
  removeOutsideListener = null
}

function positionFloatingMenu(menu: HTMLElement, anchorRect: DOMRect): void {
  const viewportPadding = 10
  const gap = 6
  const maxMenuHeight = Math.min(360, Math.max(120, window.innerHeight - viewportPadding * 2))
  const availableBelow = window.innerHeight - anchorRect.bottom - viewportPadding - gap
  const availableAbove = anchorRect.top - viewportPadding - gap
  const preferredHeight = Math.min(menu.scrollHeight, maxMenuHeight)
  const shouldOpenAbove = availableBelow < preferredHeight && availableAbove > availableBelow
  const availableHeight = Math.max(120, shouldOpenAbove ? availableAbove : availableBelow)
  const menuHeight = Math.min(maxMenuHeight, availableHeight)
  const left = Math.min(
    Math.max(anchorRect.left, viewportPadding),
    Math.max(viewportPadding, window.innerWidth - menu.offsetWidth - viewportPadding),
  )
  const top = shouldOpenAbove
    ? Math.max(viewportPadding, anchorRect.top - menuHeight - gap)
    : Math.min(anchorRect.bottom + gap, window.innerHeight - viewportPadding - menuHeight)

  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.maxHeight = `${menuHeight}px`
}

function moveBlockRangeAtPoint(
  editor: Editor,
  view: EditorView,
  sourcePos: number,
  _clientX: number,
  clientY: number,
): BlockRange | null {
  const sourceNode = view.state.doc.nodeAt(sourcePos)
  if (!Number.isFinite(sourcePos) || !sourceNode) {
    return null
  }
  const sourceRange = getMovableBlockRange(view.state, sourcePos)

  const targetBlock = getTopLevelBlockAtPoint(view, clientY, sourceRange)
  if (!targetBlock) {
    return null
  }

  const sourceIndent = getIndentLevel(sourceNode)
  const targetRootBlock = getSwapTargetBlock(view.state, targetBlock, sourceIndent)
  const targetRange = getMovableBlockRange(view.state, targetRootBlock.pos)
  const targetRect = getBlockRangeClientRect(view, targetRange)
  if (!targetRect) {
    return null
  }

  const shouldInsertAfter = clientY > targetRect.top + targetRect.height / 2
  const insertPos = resolveDropInsertPosition(sourceRange, targetRange, shouldInsertAfter)

  if (insertPos >= sourceRange.from && insertPos <= sourceRange.to) {
    return null
  }

  return moveTopLevelBlockRangeAsJson(editor, view, sourceRange, insertPos)
}

export function resolveDropInsertPosition(
  sourceRange: BlockRange,
  targetRange: BlockRange,
  shouldInsertAfter: boolean,
): number {
  const naturalInsertPos = shouldInsertAfter ? targetRange.to : targetRange.from

  if (naturalInsertPos === sourceRange.from && targetRange.to === sourceRange.from) {
    return targetRange.from
  }

  if (naturalInsertPos === sourceRange.to && targetRange.from === sourceRange.to) {
    return targetRange.to
  }

  return naturalInsertPos
}

function getBlockRangeDomElements(view: EditorView, range: BlockRange): HTMLElement[] {
  return getTopLevelBlocksInRange(view.state, range.from, range.to)
    .map((block) => getBlockElement(view, block.pos))
    .filter((element): element is HTMLElement => element !== null)
}

function applyDraggingDomState(elements: HTMLElement[], isDragging: boolean): void {
  for (const element of elements) {
    element.classList.toggle(DRAG_LIVE_BLOCK_CLASS, isDragging)

    if (isDragging) {
      element.style.willChange = 'transform'
      element.style.transition = 'none'
    } else {
      element.style.willChange = ''
      element.style.transition = ''
    }
  }
}

function forceDragEndDomRefresh(view: EditorView): void {
  cleanupDragDomState(view)
  view.updateState(view.state)

  globalThis.requestAnimationFrame(() => {
    cleanupDragDomState(view)
    view.updateState(view.state)
  })
}

function cloneEditorJson<T>(content: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(content)
  }

  return JSON.parse(JSON.stringify(content)) as T
}

function moveTopLevelBlockRangeAsJson(
  editor: Editor,
  view: EditorView,
  sourceRange: BlockRange,
  insertPos: number,
): BlockRange | null {
  const currentContent = cloneEditorJson(editor.getJSON())
  const topLevelContent = currentContent.content
  if (!Array.isArray(topLevelContent)) {
    return null
  }

  const sourceStartIndex = getTopLevelInsertIndex(view.state, sourceRange.from)
  const sourceEndIndex = getTopLevelInsertIndex(view.state, sourceRange.to)
  const insertIndex = getTopLevelInsertIndex(view.state, insertPos)
  const movedCount = sourceEndIndex - sourceStartIndex
  if (
    movedCount <= 0 ||
    sourceStartIndex < 0 ||
    sourceEndIndex > topLevelContent.length ||
    insertIndex < 0 ||
    insertIndex > topLevelContent.length
  ) {
    return null
  }

  const adjustedInsertIndex =
    insertIndex > sourceStartIndex ? insertIndex - movedCount : insertIndex
  if (adjustedInsertIndex === sourceStartIndex) {
    return null
  }

  const movedBlocks = topLevelContent.slice(sourceStartIndex, sourceEndIndex)
  const remainingBlocks = [
    ...topLevelContent.slice(0, sourceStartIndex),
    ...topLevelContent.slice(sourceEndIndex),
  ]
  const nextBlocks = [
    ...remainingBlocks.slice(0, adjustedInsertIndex),
    ...movedBlocks,
    ...remainingBlocks.slice(adjustedInsertIndex),
  ]
  const nextContent: JSONContent = {
    ...currentContent,
    content: nextBlocks,
  }

  editor.commands.setContent(nextContent, {
    emitUpdate: true,
    errorOnInvalidContent: true,
  })

  const movedRange = getTopLevelIndexRange(editor.state, adjustedInsertIndex, movedCount)
  if (!movedRange) {
    return null
  }

  editor.view.dispatch(
    editor.view.state.tr
      .setSelection(NodeSelection.create(editor.view.state.doc, movedRange.from))
      .setMeta(BlockControlsPluginKey, movedRange)
      .scrollIntoView(),
  )
  editor.view.focus()
  return movedRange
}

function getTopLevelInsertIndex(state: EditorState, position: number): number {
  let offset = 0

  for (let index = 0; index < state.doc.childCount; index += 1) {
    if (position <= offset) {
      return index
    }

    offset += state.doc.child(index).nodeSize
    if (position <= offset) {
      return index + 1
    }
  }

  return state.doc.childCount
}

function getTopLevelIndexRange(
  state: EditorState,
  startIndex: number,
  count: number,
): BlockRange | null {
  if (count <= 0 || startIndex < 0 || startIndex + count > state.doc.childCount) {
    return null
  }

  let offset = 0
  let from = 0
  let to = 0

  for (let index = 0; index < state.doc.childCount; index += 1) {
    if (index === startIndex) {
      from = offset
    }

    offset += state.doc.child(index).nodeSize

    if (index === startIndex + count - 1) {
      to = offset
      break
    }
  }

  return { from, to }
}

function cleanupDragDomState(view: EditorView): void {
  const root = view.dom.closest('.editor-shell') ?? view.dom
  const dragSelector = [
    `.${PRESSED_BLOCK_CLASS}`,
    `.${DRAGGING_BLOCK_CLASS}`,
    `.${DRAG_LIVE_BLOCK_CLASS}`,
    `.${PRESSED_HANDLE_CLASS}`,
    `.${DRAGGING_HANDLE_CLASS}`,
  ].join(',')

  root.querySelectorAll(dragSelector).forEach((element) => {
    element.classList.remove(
      PRESSED_BLOCK_CLASS,
      DRAGGING_BLOCK_CLASS,
      DRAG_LIVE_BLOCK_CLASS,
      PRESSED_HANDLE_CLASS,
      DRAGGING_HANDLE_CLASS,
    )

    if (element instanceof HTMLElement) {
      element.style.willChange = ''
      element.style.transition = ''
      element.style.transform = ''
    }
  })
}

function getDropIndicatorElement(view: EditorView): HTMLElement | null {
  return view.dom.closest('.editor-shell')?.querySelector('.block-drop-indicator') ?? null
}

function updateDropIndicator(
  view: EditorView,
  drag: ActiveDrag,
  _clientX: number,
  clientY: number,
): void {
  const indicator = drag.dropIndicator
  if (!indicator) {
    return
  }

  const targetBlock = getTopLevelBlockAtPoint(view, clientY, drag.range)
  if (!targetBlock) {
    hideDropIndicator(indicator)
    return
  }

  const sourceNode = view.state.doc.nodeAt(drag.range.from)
  if (!sourceNode) {
    hideDropIndicator(indicator)
    return
  }

  const targetRootBlock = getSwapTargetBlock(view.state, targetBlock, getIndentLevel(sourceNode))
  const targetRange = getMovableBlockRange(view.state, targetRootBlock.pos)
  const targetElement = getBlockElement(view, targetRootBlock.pos)
  const targetRect = getBlockRangeClientRect(view, targetRange)
  const scrollContainer = view.dom.closest('.editor-shell') as HTMLElement | null
  if (!targetElement || !targetRect || !scrollContainer) {
    hideDropIndicator(indicator)
    return
  }

  const containerRect = scrollContainer.getBoundingClientRect()
  const shouldInsertAfter = clientY > targetRect.top + targetRect.height / 2
  const top = shouldInsertAfter ? targetRect.bottom : targetRect.top

  clearDropIndicatorHideTimer(indicator)
  indicator.style.display = 'block'
  indicator.style.opacity = '1'
  indicator.style.top = `${top - containerRect.top + scrollContainer.scrollTop}px`
  indicator.style.left = `${targetRect.left - containerRect.left + scrollContainer.scrollLeft}px`
  indicator.style.width = `${targetRect.width}px`
}

function hideDropIndicator(indicator: HTMLElement | null): void {
  if (!indicator) {
    return
  }

  clearDropIndicatorHideTimer(indicator)
  indicator.style.opacity = '0'
  const timer = globalThis.setTimeout(() => {
    if (indicator.style.opacity === '0') {
      indicator.style.display = 'none'
    }
  }, 120)
  indicator.dataset.hideTimer = String(timer)
}

function clearDropIndicatorHideTimer(indicator: HTMLElement): void {
  const timer = Number(indicator.dataset.hideTimer)
  if (Number.isFinite(timer) && timer > 0) {
    globalThis.clearTimeout(timer)
  }

  delete indicator.dataset.hideTimer
}

function addBlockRangeDomClass(view: EditorView, range: BlockRange, className: string): void {
  for (const block of getTopLevelBlocksInRange(view.state, range.from, range.to)) {
    const element = getBlockElement(view, block.pos)
    if (element) {
      element.classList.add(className)
    }
  }
}

function removeBlockRangeDomClass(view: EditorView, range: BlockRange, className: string): void {
  for (const block of getTopLevelBlocksInRange(view.state, range.from, range.to)) {
    const element = getBlockElement(view, block.pos)
    if (element) {
      element.classList.remove(className)
    }
  }
}

function clearPressedBlockRange(view: EditorView): void {
  if (!pressedRange) {
    return
  }

  removeBlockRangeDomClass(view, pressedRange, PRESSED_BLOCK_CLASS)
  pressedRange = null
}

function getTopLevelBlockAtSelection(state: EditorState): TopLevelBlock | null {
  const selectionFrom = state.selection.from
  let offset = 0

  for (let index = 0; index < state.doc.childCount; index += 1) {
    const node = state.doc.child(index)
    const end = offset + node.nodeSize

    if (selectionFrom >= offset && selectionFrom <= end) {
      return { node, pos: offset }
    }

    offset = end
  }

  return null
}

function getTopLevelBlocksInRange(state: EditorState, from: number, to: number): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = []
  let offset = 0

  for (let index = 0; index < state.doc.childCount; index += 1) {
    const node = state.doc.child(index)
    const end = offset + node.nodeSize

    if (offset >= from && end <= to) {
      blocks.push({ node, pos: offset })
    }

    offset = end
  }

  return blocks
}

function getSwapTargetBlock(
  state: EditorState,
  targetBlock: TopLevelBlock,
  sourceIndent: number,
): TopLevelBlock {
  let candidate = targetBlock
  let offset = 0

  for (let index = 0; index < state.doc.childCount; index += 1) {
    const node = state.doc.child(index)
    const nodeStart = offset
    const nodeEnd = nodeStart + node.nodeSize

    if (nodeStart > targetBlock.pos) {
      break
    }

    if (nodeStart <= targetBlock.pos && targetBlock.pos < nodeEnd) {
      if (getIndentLevel(node) <= sourceIndent) {
        candidate = { node, pos: nodeStart }
      }
      break
    }

    if (getIndentLevel(node) <= sourceIndent) {
      candidate = { node, pos: nodeStart }
    }

    offset = nodeEnd
  }

  return candidate
}

function getBlockRangeClientRect(view: EditorView, range: BlockRange): BlockClientRect | null {
  const blocks = getTopLevelBlocksInRange(view.state, range.from, range.to)
  if (blocks.length === 0) {
    return null
  }

  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  let left = Number.POSITIVE_INFINITY

  for (const block of blocks) {
    const rect = getInteractiveBlockClientRect(view, block.pos)
    if (!rect) {
      continue
    }

    top = Math.min(top, rect.top)
    right = Math.max(right, rect.left + rect.width)
    bottom = Math.max(bottom, rect.bottom)
    left = Math.min(left, rect.left)
  }

  if (
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom) ||
    !Number.isFinite(left)
  ) {
    return null
  }

  return {
    top,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
  }
}

function getControllableTopLevelBlocks(state: EditorState): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = []
  let offset = 0

  for (let index = 0; index < state.doc.childCount; index += 1) {
    const node = state.doc.child(index)

    if (isControllableBlock(node)) {
      blocks.push({ node, pos: offset })
    }

    offset += node.nodeSize
  }

  return blocks
}

function getMovableBlockRange(state: EditorState, sourcePos: number): BlockRange {
  const sourceNode = state.doc.nodeAt(sourcePos)
  if (!sourceNode) {
    return { from: sourcePos, to: sourcePos }
  }

  const sourceIndent = getIndentLevel(sourceNode)
  let rangeEnd = sourcePos + sourceNode.nodeSize
  let offset = 0
  let foundSource = false

  for (let index = 0; index < state.doc.childCount; index += 1) {
    const node = state.doc.child(index)
    const nodeStart = offset
    const nodeEnd = nodeStart + node.nodeSize

    if (nodeStart === sourcePos) {
      foundSource = true
      rangeEnd = nodeEnd
      offset = nodeEnd
      continue
    }

    if (foundSource) {
      if (getIndentLevel(node) <= sourceIndent) {
        break
      }

      rangeEnd = nodeEnd
    }

    offset = nodeEnd
  }

  return { from: sourcePos, to: rangeEnd }
}

function getTopLevelBlockAtPoint(
  view: EditorView,
  top: number,
  excludedRange?: BlockRange,
): TopLevelBlock | null {
  let closestBlock: TopLevelBlock | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  let firstBlockTop = Number.POSITIVE_INFINITY
  let lastBlockBottom = Number.NEGATIVE_INFINITY

  for (const block of getControllableTopLevelBlocks(view.state)) {
    if (excludedRange && block.pos >= excludedRange.from && block.pos < excludedRange.to) {
      continue
    }

    if (isTrailingEmptyParagraph(view.state, block)) {
      continue
    }

    const element = getBlockElement(view, block.pos)
    if (!element) {
      continue
    }

    const rect = getInteractiveBlockClientRect(view, block.pos)
    if (!rect) {
      continue
    }

    firstBlockTop = Math.min(firstBlockTop, rect.top)
    lastBlockBottom = Math.max(lastBlockBottom, rect.bottom)
    if (top >= rect.top && top <= rect.bottom) {
      return block
    }

    const distance = top < rect.top ? rect.top - top : top - rect.bottom
    if (distance < closestDistance) {
      closestDistance = distance
      closestBlock = block
    }
  }

  if (top < firstBlockTop || top > lastBlockBottom) {
    return null
  }

  return closestBlock
}

function getInteractiveBlockClientRect(view: EditorView, pos: number): BlockClientRect | null {
  const element = getBlockElement(view, pos)
  if (!element) {
    return null
  }

  const rect = element.getBoundingClientRect()
  const adjacentBlocks = getAdjacentControllableBlocks(view.state, pos)
  const previousRect = adjacentBlocks.previous
    ? getRawBlockClientRect(view, adjacentBlocks.previous.pos)
    : null
  const nextRect = adjacentBlocks.next ? getRawBlockClientRect(view, adjacentBlocks.next.pos) : null

  const top = previousRect ? (previousRect.bottom + rect.top) * 0.5 : rect.top
  const bottom = nextRect ? (rect.bottom + nextRect.top) * 0.5 : rect.bottom
  return {
    top,
    bottom,
    left: rect.left,
    width: rect.width,
    height: bottom - top,
  }
}

function getRawBlockClientRect(view: EditorView, pos: number): DOMRect | null {
  const element = getBlockElement(view, pos)
  return element?.getBoundingClientRect() ?? null
}

function getAdjacentControllableBlocks(
  state: EditorState,
  pos: number,
): { previous: TopLevelBlock | null; next: TopLevelBlock | null } {
  const blocks = getControllableTopLevelBlocks(state)
  const index = blocks.findIndex((block) => block.pos === pos)

  return {
    previous: index > 0 ? blocks[index - 1] : null,
    next: index >= 0 && index < blocks.length - 1 ? blocks[index + 1] : null,
  }
}

function countTrailingEmptyParagraphs(state: EditorState): number {
  let count = 0

  for (let index = state.doc.childCount - 1; index >= 0; index -= 1) {
    const node = state.doc.child(index)
    if (!isEmptyParagraph(node)) {
      break
    }

    count += 1
  }

  return count
}

function trimExcessTrailingEmptyParagraphs(view: EditorView, allowedTrailingCount: number): void {
  let trailingCount = countTrailingEmptyParagraphs(view.state)
  const excessCount = trailingCount - allowedTrailingCount
  if (excessCount <= 0 || view.state.doc.childCount <= 1) {
    return
  }

  let transaction = view.state.tr
  let offset = view.state.doc.content.size
  let removedCount = 0

  for (let index = view.state.doc.childCount - 1; index >= 0; index -= 1) {
    const node = view.state.doc.child(index)
    const nodeStart = offset - node.nodeSize
    if (!isEmptyParagraph(node) || removedCount >= excessCount || transaction.doc.childCount <= 1) {
      break
    }

    transaction = transaction.delete(nodeStart, offset)
    offset = nodeStart
    removedCount += 1
    trailingCount -= 1
  }

  if (removedCount > 0) {
    view.dispatch(
      transaction.setMeta(
        BlockControlsPluginKey,
        BlockControlsPluginKey.getState(view.state)?.draggingRange ?? null,
      ),
    )
  }
}

function isTrailingEmptyParagraph(state: EditorState, block: TopLevelBlock): boolean {
  return block.pos + block.node.nodeSize === state.doc.content.size && isEmptyParagraph(block.node)
}

function isEmptyParagraph(node: ProseMirrorNode): boolean {
  return node.type.name === 'paragraph' && node.textContent.trim() === ''
}

function getBlockElement(view: EditorView, pos: number): HTMLElement | null {
  const nodeDom = view.nodeDOM(pos)
  if (nodeDom instanceof HTMLElement) {
    if (nodeDom.matches('[data-editor-block-pos]')) {
      return nodeDom
    }

    const decoratedAncestor = nodeDom.closest<HTMLElement>('[data-editor-block-pos]')
    if (decoratedAncestor) {
      return decoratedAncestor
    }
  }

  const element = view.dom.querySelector(`[data-editor-block-pos="${pos}"]`)
  return element instanceof HTMLElement ? element : null
}

function selectBlock(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) {
    return
  }

  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
  editor.view.focus()
}

function focusInsideBlock(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) {
    return
  }

  const textPosition = Math.min(pos + 1, editor.state.doc.content.size)
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, textPosition)),
  )
  editor.view.focus()
}

function isControllableBlock(node: ProseMirrorNode): boolean {
  return node.type.isBlock && node.type.name !== 'listItem' && node.type.name !== 'taskItem'
}

function indentSelectedBlock(editor: Editor, delta: 1 | -1): boolean {
  if (!editor.isEditable || editor.isActive('codeBlock')) {
    return false
  }

  const activeBlock = getTopLevelBlockAtSelection(editor.state)
  if (!activeBlock || !isControllableBlock(activeBlock.node)) {
    return false
  }

  const currentIndent = getIndentLevel(activeBlock.node)
  const nextIndent = normalizeIndentLevel(currentIndent + delta)
  if (nextIndent === currentIndent) {
    return true
  }

  editor
    .chain()
    .focus()
    .setNodeSelection(activeBlock.pos)
    .updateAttributes(activeBlock.node.type.name, { [INDENT_ATTRIBUTE]: nextIndent })
    .run()

  focusInsideBlock(editor, activeBlock.pos)
  return true
}

function outdentIndentedBlockOnBackspace(editor: Editor): boolean {
  if (!editor.isEditable || editor.isActive('codeBlock')) {
    return false
  }

  const { selection } = editor.state
  if (!selection.empty || !(selection instanceof TextSelection)) {
    return false
  }

  const activeBlock = getTopLevelBlockAtSelection(editor.state)
  if (!activeBlock || !isControllableBlock(activeBlock.node)) {
    return false
  }

  const currentIndent = getIndentLevel(activeBlock.node)
  if (currentIndent === 0 || !isCursorAtStartOfBlock(activeBlock, selection.from)) {
    return false
  }

  const nextIndent = activeBlock.node.textContent.trim() === '' ? 0 : currentIndent - 1

  editor
    .chain()
    .focus()
    .setNodeSelection(activeBlock.pos)
    .updateAttributes(activeBlock.node.type.name, { [INDENT_ATTRIBUTE]: nextIndent })
    .run()

  focusInsideBlock(editor, activeBlock.pos)
  return true
}

function isCursorAtStartOfBlock(block: TopLevelBlock, cursorPosition: number): boolean {
  const offsetInsideBlock = cursorPosition - block.pos - 1
  if (offsetInsideBlock < 0) {
    return false
  }

  return block.node.textBetween(0, offsetInsideBlock, '\n', '\n').length === 0
}

function getIndentLevel(node: ProseMirrorNode): number {
  return normalizeIndentLevel(node.attrs[INDENT_ATTRIBUTE])
}

function getBlockId(node: ProseMirrorNode): string {
  const blockId = node.attrs[BLOCK_ID_ATTRIBUTE]
  return typeof blockId === 'string' ? blockId : ''
}
