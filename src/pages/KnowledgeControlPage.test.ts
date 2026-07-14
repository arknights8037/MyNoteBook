import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import KnowledgeControlPage from './KnowledgeControlPage.vue'

const control = vi.hoisted(() => ({
  load: vi.fn(async () => ({ objects: [], views: [], taskRuns: [] })),
}))

vi.mock('@/app/composition/knowledgeControlServiceFactory', () => ({
  createKnowledgeControlService: async () => control,
}))

describe('KnowledgeControlPage', () => {
  it('exposes Knowledge, View and TaskRun verification surfaces', async () => {
    const wrapper = mount(KnowledgeControlPage, {
      props: { currentDocumentId: 'doc-1', currentDocumentRevision: 3 },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('知识规则')

    const tabs = wrapper.findAll('[role="tab"]')
    await tabs.find((tab) => tab.text().includes('智能视图'))?.trigger('click')
    expect(wrapper.text()).toContain('视图不会修改原始文档')

    await tabs.find((tab) => tab.text().includes('任务验收'))?.trigger('click')
    expect(wrapper.text()).toContain('任务结果需要独立验收')
    expect(control.load).toHaveBeenCalled()
  })
})
