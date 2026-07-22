import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/vue-3'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import EditorShell from '@/editor/components/EditorShell.vue'
import type { TiptapDocumentJson } from '@/models/documents/document'
import type { AssetPort } from '@/services/ports/AssetPort'

const { storeFile } = vi.hoisted(() => ({ storeFile: vi.fn() }))
const assetPort = {
  storeFile,
  findAsset: vi.fn(async () => null),
  resolveAssetUrl: vi.fn(async (value: string) => value),
  openAsset: vi.fn(async () => undefined),
  deleteAsset: vi.fn(async () => undefined),
} as AssetPort

interface EditorShellExpose {
  editor?: Editor
  getJSON: () => TiptapDocumentJson | undefined
}

describe('EditorShell image paste', () => {
  it('pastes an image from the clipboard at the current selection', async () => {
    storeFile.mockResolvedValue({ id: 'asset-paste-1', originalName: '剪贴板图片.png' })
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        assetPort,
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
      expect(imageNode?.attrs?.src).toBe('asset://asset-paste-1')
    })
    wrapper.unmount()
  })
})
