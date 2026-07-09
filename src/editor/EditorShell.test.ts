import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/vue-3'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import EditorShell from './EditorShell.vue'
import type { TiptapDocumentJson } from '@/models/document'
import { DEFAULT_APP_SETTINGS } from '@/models/settings'

interface EditorShellExpose {
  editor?: Editor
  shouldShowBubbleMenu: (options: { editor: Editor; from: number; to: number }) => boolean
  getJSON: () => TiptapDocumentJson | undefined
  getText: () => string
  focus: () => boolean | undefined
  insertImage: () => void
}

describe('EditorShell', () => {
  afterEach(() => {
    document.body.replaceChildren()
    globalThis.localStorage.clear()
  })

  it('renders initial JSON content', async () => {
    const content: TiptapDocumentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '阶段二编辑器' }],
        },
      ],
    }

    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: content,
      },
    })

    await nextTick()

    const shell = wrapper.vm as unknown as EditorShellExpose
    expect(shell.getText()).toContain('阶段二编辑器')
    expect(shell.getJSON()).toMatchObject(content)
    wrapper.unmount()
  })

  it('applies readonly mode to the ProseMirror surface', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        readonly: true,
      },
    })

    await nextTick()

    const shell = wrapper.vm as unknown as EditorShellExpose
    expect(shell.editor?.isEditable).toBe(false)
    wrapper.unmount()
  })

  it('destroys the editor when unmounted', async () => {
    const wrapper = mount(EditorShell)
    await nextTick()

    const shell = wrapper.vm as unknown as EditorShellExpose
    const activeEditor = shell.editor

    wrapper.unmount()

    expect(wrapper.emitted('destroy')).toHaveLength(1)
    expect(activeEditor?.isDestroyed).toBe(true)
  })

  it('adds stable node ids to top-level blocks', async () => {
    const wrapper = mount(EditorShell)
    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    const documentJson = shell.getJSON()
    const firstBlock = documentJson?.content?.[0]

    expect(isRecord(firstBlock?.attrs)).toBe(true)
    if (!isRecord(firstBlock?.attrs)) {
      wrapper.unmount()
      return
    }

    expect(firstBlock.attrs.id).toEqual(expect.stringMatching(uuidRegex()))
    wrapper.unmount()
  })

  it('persists text color marks', async () => {
    const content: TiptapDocumentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '颜色文字' }],
        },
      ],
    }

    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: content,
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.editor?.chain().setTextSelection({ from: 1, to: 3 }).setColor('#dc2626').run()

    const documentJson = shell.getJSON()
    expect(JSON.stringify(documentJson)).toContain('"color":"#dc2626"')
    wrapper.unmount()
  })

  it('persists paragraph alignment', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '居中文字' }],
            },
          ],
        },
      },
      global: {
        stubs: {
          BubbleMenu: {
            template: '<div><slot /></div>',
          },
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.editor?.chain().setTextSelection(2).setTextAlign('center').run()
    await nextTick()

    expect(shell.getJSON()?.content?.[0]?.attrs?.textAlign).toBe('center')
    expect(wrapper.find('.editor-block-container').classes()).toContain(
      'editor-block-container--align-center',
    )
    wrapper.unmount()
  })

  it('inserts an image and keeps its editable caption in document JSON', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [{ type: 'paragraph' }],
        },
      },
      global: {
        stubs: {
          BubbleMenu: {
            template: '<div><slot /></div>',
          },
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.insertImage()

    const input = wrapper.get<HTMLInputElement>('.editor-shell__image-input')
    const file = new File(['image-bytes'], '示例.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20))
    await nextTick()

    const imageNode = shell.getJSON()?.content?.find((node) => node.type === 'imageFigure')
    expect(imageNode?.attrs).toMatchObject({
      alt: '示例.png',
      originalName: '示例.png',
    })
    expect(imageNode?.attrs?.src).toMatch(/^data:image\/png;base64,/)
    expect(wrapper.find('.image-figure__caption').attributes('data-placeholder')).toBe(
      '添加题注（可选）',
    )

    let imagePosition = -1
    shell.editor?.state.doc.descendants((node, position) => {
      if (node.type.name === 'imageFigure') imagePosition = position
    })
    shell.editor?.commands.insertContentAt(imagePosition + 1, '图片题注')
    expect(shell.getJSON()?.content?.find((node) => node.type === 'imageFigure')?.content).toEqual([
      { type: 'text', text: '图片题注' },
    ])
    wrapper.unmount()
  })

  it('applies center alignment from the bubble toolbar without losing the selection', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '通过工具栏居中' }],
            },
          ],
        },
      },
      global: {
        stubs: {
          BubbleMenu: {
            template: '<div><slot /></div>',
          },
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.editor?.commands.setTextSelection({ from: 1, to: 5 })
    await nextTick()
    await flushPromises()

    const centerButton = document.body.querySelector('button[aria-label="居中对齐"]')
    expect(centerButton).not.toBeNull()
    centerButton?.dispatchEvent(
      new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    centerButton?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(shell.getJSON()?.content?.[0]?.attrs?.textAlign).toBe('center')
    expect(wrapper.find('.editor-block-container').classes()).toContain(
      'editor-block-container--align-center',
    )
    wrapper.unmount()
  })

  it('opens the color palette and records recently used colors', async () => {
    globalThis.localStorage.clear()
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '调色盘测试' }],
            },
          ],
        },
      },
      global: {
        stubs: {
          BubbleMenu: {
            template: '<div><slot /></div>',
          },
        },
      },
    })

    await nextTick()
    await flushPromises()

    const colorButton = document.body.querySelector('button[aria-label="文字颜色"]')
    expect(colorButton).not.toBeNull()
    colorButton?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
    await nextTick()
    await flushPromises()

    const redSwatch = document.body.querySelector('button[aria-label="设置文字颜色 #dc2626"]')
    expect(redSwatch).not.toBeNull()
    redSwatch?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(
      JSON.parse(globalThis.localStorage.getItem('my-notebook:recent-text-colors') ?? '[]'),
    ).toEqual(['#dc2626'])
    expect(document.body.querySelector('[aria-label="最近使用的文字颜色"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('opens the highlighter palette and records recently used highlight colors', async () => {
    globalThis.localStorage.clear()
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '高亮测试' }],
            },
          ],
        },
      },
      global: {
        stubs: {
          BubbleMenu: {
            template: '<div><slot /></div>',
          },
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.editor?.commands.setTextSelection({ from: 1, to: 3 })

    await wrapper.get('button[aria-label="荧光笔"]').trigger('click')
    await nextTick()
    await flushPromises()

    const yellowSwatch = document.body.querySelector('button[aria-label="设置高亮颜色 #fef08a"]')
    expect(yellowSwatch).not.toBeNull()
    yellowSwatch?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
    await nextTick()

    const marks = shell.getJSON()?.content?.[0]?.content?.[0]?.marks ?? []
    expect(marks).toContainEqual({ type: 'highlight', attrs: { color: '#fef08a' } })
    expect(
      JSON.parse(globalThis.localStorage.getItem('my-notebook:recent-highlight-colors') ?? '[]'),
    ).toEqual(['#fef08a'])
    wrapper.unmount()
  })

  it('hides the bubble menu inside code blocks', async () => {
    const wrapper = mount(EditorShell, {
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              content: [{ type: 'text', text: 'const answer = 42' }],
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    expect(shell.editor).toBeDefined()
    if (!shell.editor) return

    expect(shell.shouldShowBubbleMenu({ editor: shell.editor, from: 1, to: 3 })).toBe(false)
    wrapper.unmount()
  })

  it('shows the bubble menu outside code blocks', async () => {
    const wrapper = mount(EditorShell, {
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '普通文本' }],
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    expect(shell.editor).toBeDefined()
    if (!shell.editor) return

    expect(shell.shouldShowBubbleMenu({ editor: shell.editor, from: 1, to: 3 })).toBe(true)
    wrapper.unmount()
  })

  it('previews picker drag colors without stealing focus or recording intermediate colors', async () => {
    globalThis.localStorage.clear()
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '拖动调色盘' }],
            },
          ],
        },
      },
      global: {
        stubs: {
          BubbleMenu: {
            template: '<div><slot /></div>',
          },
        },
      },
    })

    await nextTick()
    await flushPromises()

    await wrapper.get('button[aria-label="文字颜色"]').trigger('click')
    await nextTick()
    await flushPromises()

    const picker = document.body.querySelector<HTMLInputElement>('input[type="color"]')
    expect(picker).not.toBeNull()
    if (!picker) return

    picker.focus()
    picker.value = '#784545'
    picker.dispatchEvent(new globalThis.Event('input', { bubbles: true }))
    await nextTick()

    expect(document.activeElement).toBe(picker)
    expect(globalThis.localStorage.getItem('my-notebook:recent-text-colors')).toBeNull()

    picker.dispatchEvent(new globalThis.Event('change', { bubbles: true }))
    await nextTick()

    expect(
      JSON.parse(globalThis.localStorage.getItem('my-notebook:recent-text-colors') ?? '[]'),
    ).toEqual(['#784545'])
    wrapper.unmount()
  })

  it('renders tab indentation on block containers', async () => {
    const content: TiptapDocumentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { indentLevel: 2 },
          content: [{ type: 'text', text: '缩进正文' }],
        },
        {
          type: 'heading',
          attrs: { level: 2, indentLevel: 1 },
          content: [{ type: 'text', text: '缩进标题' }],
        },
      ],
    }

    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: content,
      },
    })

    await nextTick()
    await flushPromises()

    const blocks = wrapper.element.querySelectorAll(
      '.editor-shell__content > [data-editor-block-pos]',
    )
    const paragraphBlock = blocks[0] as HTMLElement | undefined
    const headingBlock = blocks[1] as HTMLElement | undefined

    expect(paragraphBlock?.getAttribute('data-indent-level')).toBe('2')
    expect(paragraphBlock?.style.getPropertyValue('--block-indent-level')).toBe('2')
    expect(headingBlock?.getAttribute('data-indent-level')).toBe('1')
    expect(headingBlock?.style.getPropertyValue('--block-indent-level')).toBe('1')
    wrapper.unmount()
  })

  it('keeps the insert-block placeholder available at maximum indentation', async () => {
    const wrapper = mount(EditorShell, {
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { indentLevel: 6 },
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    const paragraphBlock = wrapper.get('[data-indent-level="6"]')
    expect(paragraphBlock.classes()).toContain('is-empty')
    expect(paragraphBlock.attributes('data-placeholder')).toBe('输入 / 插入块')
    expect(paragraphBlock.attributes('style')).toContain('--block-indent-level: 6')
    wrapper.unmount()
  })

  it('exits indentation when backspacing an empty indented continuation block', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { indentLevel: 2 },
              content: [{ type: 'text', text: '缩进内容' }],
            },
            {
              type: 'paragraph',
              attrs: { indentLevel: 2 },
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    expect(shell.editor).toBeDefined()
    if (!shell.editor) return

    const secondBlockPosition = shell.editor.state.doc.child(0).nodeSize
    shell.editor
      .chain()
      .focus()
      .setTextSelection(secondBlockPosition + 1)
      .run()
    shell.editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    )
    await nextTick()

    expect(shell.getJSON()?.content?.[1]?.attrs?.indentLevel ?? 0).toBe(0)
    wrapper.unmount()
  })

  it('applies block handle states to text blocks', async () => {
    const content: TiptapDocumentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '正文块' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '标题块' }],
        },
      ],
    }

    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: content,
      },
    })

    await nextTick()
    await flushPromises()
    await new Promise((resolve) => requestAnimationFrame(resolve))

    const editorShell = wrapper.find('.editor-shell').element
    const blocks = editorShell.querySelectorAll('.editor-shell__content > [data-editor-block-pos]')
    const handles = editorShell.querySelectorAll('.block-control-handle')

    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(handles.length).toBeGreaterThanOrEqual(2)
    expect(blocks[0]?.tagName).toBe('DIV')
    expect(blocks[1]?.tagName).toBe('DIV')
    expect(blocks[0]?.getAttribute('data-editor-block-id')).toMatch(uuidRegex())
    expect(blocks[1]?.getAttribute('data-editor-block-id')).toMatch(uuidRegex())
    expect(blocks[0]?.querySelector('.editor-block-container__content')?.tagName).toBe('P')
    expect(blocks[1]?.querySelector('.editor-block-container__content')?.tagName).toBe('H2')

    handles[0]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))

    expect(blocks[0]?.classList.contains('editor-block--pressed')).toBe(true)
    expect(handles[0]?.classList.contains('block-control-handle--pressed')).toBe(true)

    const shell = wrapper.vm as unknown as EditorShellExpose
    editorShell.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    shell.editor?.commands.setNodeSelection(0)
    await nextTick()
    await flushPromises()

    expect(blocks[0]?.classList.contains('editor-block--selected')).toBe(true)
    wrapper.unmount()
  })

  it('clears visible block selection when clicking outside the editor', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'mathBlock',
              attrs: { latex: 'E = mc^2', mathml: '' },
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '后续正文' }],
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    const editorShell = wrapper.find('.editor-shell').element
    editorShell.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    shell.editor?.commands.setNodeSelection(0)
    await nextTick()
    await flushPromises()

    expect(wrapper.find('.math-block--selected').exists()).toBe(true)

    const outsideButton = document.createElement('button')
    document.body.append(outsideButton)
    outsideButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    await nextTick()
    await flushPromises()

    expect(wrapper.find('.math-block--selected').exists()).toBe(false)
    expect(wrapper.find('.editor-block--selected').exists()).toBe(false)
    expect(shell.editor?.state.selection.empty).toBe(true)
    wrapper.unmount()
  })

  it('renders document outline jump aid for headings and collapsible headings', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        settings: { ...DEFAULT_APP_SETTINGS, jumpAid: 'outline', jumpAidMaxLevel: 2 },
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { id: '11111111-1111-4111-8111-111111111111', level: 1 },
              content: [{ type: 'text', text: '一级标题' }],
            },
            {
              type: 'collapsibleBlock',
              attrs: {
                id: '22222222-2222-4222-8222-222222222222',
                variant: 'heading',
                headingLevel: 2,
                title: '折叠标题',
              },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '内容' }] }],
            },
            {
              type: 'heading',
              attrs: { id: '44444444-4444-4444-8444-444444444444', level: 3 },
              content: [{ type: 'text', text: '三级标题' }],
            },
            {
              type: 'paragraph',
              attrs: { id: '33333333-3333-4333-8333-333333333333' },
              content: [{ type: 'text', text: '正文' }],
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    expect(wrapper.find('.editor-jump-aid--outline').exists()).toBe(true)
    expect(wrapper.findAll('.editor-jump-aid__item')).toHaveLength(2)
    expect(wrapper.find('.editor-jump-aid').text()).toContain('一级标题')
    expect(wrapper.find('.editor-jump-aid').text()).toContain('折叠标题')
    expect(wrapper.find('.editor-jump-aid').text()).not.toContain('三级标题')
    wrapper.unmount()
  })

  it('renders anchor jump aid only for the primary heading level', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        settings: { ...DEFAULT_APP_SETTINGS, jumpAid: 'anchors', jumpAidPosition: 'left' },
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { id: '11111111-1111-4111-8111-111111111111', level: 1 },
              content: [{ type: 'text', text: '一级标题' }],
            },
            {
              type: 'heading',
              attrs: { id: '22222222-2222-4222-8222-222222222222', level: 2 },
              content: [{ type: 'text', text: '二级标题' }],
            },
          ],
        },
      },
    })

    await nextTick()
    await flushPromises()

    expect(wrapper.find('.editor-jump-aid--anchors').exists()).toBe(true)
    expect(wrapper.find('.editor-jump-aid--left').exists()).toBe(true)
    expect(wrapper.findAll('.editor-jump-aid__item')).toHaveLength(1)
    expect(wrapper.find('.editor-jump-aid__item').classes()).toContain(
      'editor-jump-aid__item--level-1',
    )
    wrapper.unmount()
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function uuidRegex(): RegExp {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
}
