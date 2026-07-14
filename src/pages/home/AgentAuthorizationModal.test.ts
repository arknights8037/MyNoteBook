import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AgentAuthorizationModal from './AgentAuthorizationModal.vue'

describe('AgentAuthorizationModal', () => {
  it('shows the pending question and returns the selected option', async () => {
    const wrapper = mount(AgentAuthorizationModal, {
      props: {
        request: {
          id: 'question-1',
          question: '新页面放在哪里？',
          context: '这会影响文档层级。',
          options: ['当前页面下', '独立页面'],
          allowFreeText: true,
        },
      },
      global: {
        stubs: {
          NModal: { template: '<section><slot /><slot name="footer" /></section>' },
        NButton: { template: '<button><slot /></button>' },
        Teleport: true,
      },
      },
    })

    expect(wrapper.text()).toContain('新页面放在哪里？')
    expect(wrapper.text()).toContain('这会影响文档层级。')

    await wrapper.get('.agent-authorization-modal__option').trigger('click')

    expect(wrapper.emitted('answer')).toEqual([['question-1', '当前页面下']])
  })
})
