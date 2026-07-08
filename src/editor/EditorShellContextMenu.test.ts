import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/vue-3'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import EditorShell from './EditorShell.vue'
import { clearRetainedBlock, hasRetainedBlock } from './blockClipboard'
import type { TiptapDocumentJson } from '@/models/document'
import { DEFAULT_APP_SETTINGS } from '@/models/settings'

interface EditorShellExpose {
  editor?: Editor
  getJSON: () => TiptapDocumentJson | undefined
  insertInternalDocumentLink: (target: { id: string; title: string }) => void
  copyContextBlock: () => void
  pasteRetainedBlock: () => void
  setContextBlockPosition: (position: number) => void
}

describe('EditorShell context transactions', () => {
  beforeEach(() => clearRetainedBlock())

  it('opens the custom context menu and duplicates the active block', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '事务块' }] }],
        },
      },
      global: { stubs: { BubbleMenu: { template: '<div><slot /></div>' } } },
    })
    await nextTick()
    await flushPromises()

    wrapper.get('[data-editor-block-pos="0"]').element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 120,
        clientY: 120,
      }),
    )
    await nextTick()
    await flushPromises()

    const menu = document.body.querySelector('.editor-context-menu')
    expect(menu?.textContent).toContain('转换块类型')
    expect(menu?.textContent).toContain('链接到知识库文档')

    const duplicate = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('复制当前块'))
    duplicate?.click()
    await nextTick()

    const shell = wrapper.vm as unknown as EditorShellExpose
    expect(shell.getJSON()?.content?.filter((node) => node.type === 'paragraph')).toHaveLength(2)
    wrapper.unmount()
  })

  it('creates navigable knowledge-base links and applies editor preferences', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        settings: {
          ...DEFAULT_APP_SETTINGS,
          spellcheck: false,
          showBlockHandles: false,
          contentWidth: 'wide',
          fontSize: 'large',
          lineHeight: 'relaxed',
        },
      },
      global: { stubs: { BubbleMenu: { template: '<div><slot /></div>' } } },
    })
    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.insertInternalDocumentLink({ id: 'target-1', title: '目标文章' })
    await nextTick()

    expect(wrapper.get('.editor-shell').classes()).toContain('editor-shell--hide-block-handles')
    expect(wrapper.get('.editor-shell').attributes('style')).toContain(
      '--editor-content-width: 1000px',
    )
    expect(wrapper.get('.editor-shell__content').attributes('spellcheck')).toBe('false')
    expect(JSON.stringify(shell.getJSON())).toContain('#document=target-1')

    await wrapper.get('a[href="#document=target-1"]').trigger('click')
    expect(wrapper.emitted('openDocument')).toEqual([['target-1']])
    wrapper.unmount()
  })

  it('retains a copied block until it is pasted when configured', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '第一块' }] },
            { type: 'paragraph', content: [{ type: 'text', text: '第二块' }] },
          ],
        },
        settings: { ...DEFAULT_APP_SETTINGS, blockCopyBehavior: 'clipboard' },
      },
      global: { stubs: { BubbleMenu: { template: '<div><slot /></div>' } } },
    })
    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.setContextBlockPosition(0)
    shell.copyContextBlock()
    expect(shell.getJSON()?.content).toHaveLength(2)
    expect(hasRetainedBlock()).toBe(true)

    const secondBlockPosition = shell.editor?.state.doc.child(0).nodeSize ?? 0
    shell.setContextBlockPosition(secondBlockPosition)
    shell.pasteRetainedBlock()
    await nextTick()

    expect(shell.getJSON()?.content?.map((node) => node.content?.[0]?.text)).toEqual([
      '第一块',
      '第二块',
      '第一块',
    ])
    wrapper.unmount()
  })
})
