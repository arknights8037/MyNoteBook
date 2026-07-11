import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/vue-3'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import EditorShell from './EditorShell.vue'
import type { TiptapDocumentJson } from '@/models/document'

interface EditorShellExpose {
  editor?: Editor
  getJSON: () => TiptapDocumentJson | undefined
}

describe('EditorShell image paste', () => {
  it('pastes an image from the clipboard at the current selection', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '粘贴位置' }],
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
    shell.editor?.commands.setTextSelection(5)
    const file = new File(['clipboard-image'], '剪贴板图片.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [file], items: [], getData: () => '', setData: () => undefined },
    })

    shell.editor?.view.dom.dispatchEvent(pasteEvent)
    expect(pasteEvent.defaultPrevented).toBe(true)
    await vi.waitFor(() => {
      const imageNode = shell.getJSON()?.content?.find((node) => node.type === 'imageFigure')
      expect(imageNode?.attrs).toMatchObject({
        alt: '剪贴板图片.png',
        originalName: '剪贴板图片.png',
      })
      expect(imageNode?.attrs?.src).toMatch(/^data:image\/png;base64,/)
    })
    wrapper.unmount()
  })
})
