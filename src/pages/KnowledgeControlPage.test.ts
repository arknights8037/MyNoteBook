import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import KnowledgeControlPage from './KnowledgeControlPage.vue'

const control = vi.hoisted(() => ({
  load: vi.fn(async () => ({ objects: [], views: [], taskRuns: [] })),
}))

vi.mock('@/infrastructure/database/knowledgeControlServiceFactory', () => ({
  createKnowledgeControlService: async () => control,
}))

describe('KnowledgeControlPage', () => {
  it('exposes Knowledge, View and TaskRun verification surfaces', async () => {
    const wrapper = mount(KnowledgeControlPage, {
      props: { currentDocumentId: 'doc-1', currentDocumentRevision: 3 },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Knowledge Objects')
    expect(wrapper.text()).toContain('Query / Projection / Generated Views')
    expect(wrapper.text()).toContain('TaskRun Verification')
    expect(control.load).toHaveBeenCalled()
  })
})
