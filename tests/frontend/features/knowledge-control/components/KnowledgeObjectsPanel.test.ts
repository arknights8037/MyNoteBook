import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import KnowledgeObjectsPanel from '@/features/knowledge-control/components/KnowledgeObjectsPanel.vue'
import type { KnowledgeObject } from '@/models/knowledge/knowledge'

describe('KnowledgeObjectsPanel', () => {
  it('shows accepted Research content and opens it for review', async () => {
    const object = knowledgeObject()
    const wrapper = mount(KnowledgeObjectsPanel, {
      props: {
        objects: [object],
        objectType: 'rule',
        title: '',
        loading: false,
      },
    })

    expect(wrapper.get('.knowledge-objects-list').text()).toContain('生产 Agent 的关键是受控运行时')
    expect(wrapper.get('.knowledge-objects-list').text()).toContain('Agent 参考知识')
    await wrapper.get('.knowledge-objects-list > button').trigger('click')
    expect(wrapper.emitted('view')?.at(-1)).toEqual([object])
  })

  it('searches accepted knowledge by user category and tags', async () => {
    const wrapper = mount(KnowledgeObjectsPanel, {
      props: {
        objects: [knowledgeObject()],
        objectType: 'rule',
        title: '',
        loading: false,
      },
    })

    await wrapper.get('.knowledge-objects-toolbar input').setValue('运行时')
    expect(wrapper.findAll('.knowledge-objects-list > button')).toHaveLength(1)
    await wrapper.get('.knowledge-objects-toolbar input').setValue('财务')
    expect(wrapper.findAll('.knowledge-objects-list > button')).toHaveLength(0)
  })
})

function knowledgeObject(): KnowledgeObject {
  return {
    id: 'claim-1',
    objectType: 'claim',
    status: 'approved',
    title: '运行时约束优先',
    content: '生产 Agent 的关键是受控运行时，而非单一推理范式。',
    structuredData: {
      validationStatus: 'warning',
      userCategory: 'Agent 架构',
      userTags: ['运行时', '治理'],
    },
    generatedRunId: 'run-1',
    cognitiveMode: 'research',
    templateId: 'research-conclusions',
    templateVersion: 1,
    ownerId: null,
    scope: {},
    documentId: null,
    blockId: null,
    sourceRevision: null,
    authorityLevel: 'agent_candidate',
    confidence: 0.8,
    validFrom: null,
    validUntil: null,
    verifiedAt: 1,
    version: 2,
    createdAt: 1,
    updatedAt: 2,
  }
}
