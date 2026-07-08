import { flushPromises, mount } from '@vue/test-utils'
import type { Editor } from '@tiptap/vue-3'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import EditorShell from './EditorShell.vue'
import type { TiptapDocumentJson } from '@/models/document'

interface EditorShellExpose {
  editor?: Editor
  getJSON: () => TiptapDocumentJson | undefined
}

describe('subscript and superscript', () => {
  it('persists mutually exclusive script marks and renders bubble actions', async () => {
    const wrapper = mount(EditorShell, {
      attachTo: document.body,
      props: {
        modelValue: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H2O' }] }],
        },
      },
      global: { stubs: { BubbleMenu: { template: '<div><slot /></div>' } } },
    })
    await nextTick()
    await flushPromises()

    const shell = wrapper.vm as unknown as EditorShellExpose
    shell.editor?.chain().setTextSelection({ from: 2, to: 3 }).toggleMark('subscript').run()
    expect(JSON.stringify(shell.getJSON())).toContain('"type":"subscript"')

    shell.editor?.chain().setTextSelection({ from: 2, to: 3 }).toggleMark('superscript').run()
    const marks = shell.getJSON()?.content?.[0]?.content?.[1]?.marks ?? []
    expect(marks).toContainEqual({ type: 'superscript' })
    expect(marks).not.toContainEqual({ type: 'subscript' })
    expect(wrapper.find('button[aria-label="下标"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="上标"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
