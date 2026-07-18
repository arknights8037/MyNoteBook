import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import KnowledgeControlPage from './KnowledgeControlPage.vue'

const control = vi.hoisted(() => ({
  load: vi.fn(async () => ({ objects: [], assets: [], views: [], taskRuns: [] })),
}))

vi.mock('@/app/composition/knowledgeControlServiceFactory', () => ({
  createKnowledgeControlService: async () => control,
}))

describe('KnowledgeControlPage', () => {
  it('exposes Asset, Knowledge, View and TaskRun verification surfaces', async () => {
    const wrapper = mount(KnowledgeControlPage, {
      props: { currentDocumentId: 'doc-1', currentDocumentRevision: 3 },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('知识资产')

    const tabs = wrapper.findAll('[role="tab"]')
    await tabs.find((tab) => tab.text().includes('AI 对话记录'))?.trigger('click')
    expect(wrapper.text()).toContain('对话文件 / ZIP')

    await tabs.find((tab) => tab.text().includes('知识规则'))?.trigger('click')
    expect(wrapper.text()).toContain('统一管理 Agent 约束与已经确认的 Research 参考知识')

    await tabs.find((tab) => tab.text().includes('智能视图'))?.trigger('click')
    expect(wrapper.text()).toContain('按条件查询、整理字段')

    await tabs.find((tab) => tab.text().includes('任务验收'))?.trigger('click')
    expect(wrapper.text()).toContain('任务验收与外部协作')
    expect(control.load).toHaveBeenCalled()
  })
})
