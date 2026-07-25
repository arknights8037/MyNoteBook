import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SlidesViewEditor from '@/features/workspace-views/components/SlidesViewEditor.vue'
import { createDefaultSlidevSource, parseSlidevDeck } from '@/models/workspace/slidevDeck'
import type { SlidesViewPayload } from '@/models/workspace/workspaceView'

describe('SlidesViewEditor', () => {
  it('edits the visible title and writes the change back to Slidev markdown', async () => {
    const wrapper = mount(SlidesViewEditor, { props: { payload: createPayload() } })

    await wrapper.get('.slidev-canvas__flow h1').trigger('dblclick')
    const input = wrapper.get('input[aria-label="页面标题"]')
    await input.setValue('新的演示标题')
    await input.trigger('blur')

    const payload = wrapper.emitted('update')?.at(-1)?.[0] as SlidesViewPayload
    expect(parseSlidevDeck(payload.source)[0].title).toBe('新的演示标题')
    wrapper.unmount()
  })

  it('adds a page and a native Slidev draggable text box', async () => {
    const wrapper = mount(SlidesViewEditor, { props: { payload: createPayload() } })
    await wrapper.get('button[title="新增页面"]').trigger('click')
    const pagePayload = wrapper.emitted('update')?.at(-1)?.[0] as SlidesViewPayload
    expect(parseSlidevDeck(pagePayload.source)).toHaveLength(2)

    await wrapper.setProps({ payload: pagePayload })
    await wrapper.get('.slidev-editor__toolbar button:nth-of-type(6)').trigger('click')
    const boxPayload = wrapper.emitted('update')?.at(-1)?.[0] as SlidesViewPayload
    expect(boxPayload.source).toContain('<v-drag')
    expect(boxPayload.source).toContain('dragPos:')
    wrapper.unmount()
  })

  it('opens and closes the human presentation surface', async () => {
    const wrapper = mount(SlidesViewEditor, {
      attachTo: document.body,
      props: { payload: createPayload() },
    })
    await wrapper.get('.slidev-editor__present-button').trigger('click')
    expect(document.body.querySelector('.slidev-presentation')?.textContent).toContain('演示稿')
    const close = document.body.querySelector('button[aria-label="退出演示"]')
    ;(close as InstanceType<typeof globalThis.HTMLElement>).click()
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.slidev-presentation')).toBeNull()
    wrapper.unmount()
  })
})

function createPayload(): SlidesViewPayload {
  return {
    type: 'slides',
    format: 'slidev',
    source: createDefaultSlidevSource((prefix) => `${prefix}-1`, '演示稿'),
    assetIds: [],
  }
}
