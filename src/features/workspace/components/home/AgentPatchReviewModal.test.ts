import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AgentPatchReviewModal from './AgentPatchReviewModal.vue'
import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'

function createPatch(accepted = true): BlockPatch {
  return {
    patchId: 'patch-1',
    taskId: 'task-1',
    operation: 'replace',
    documentId: 'document-1',
    blockId: 'block-1',
    targetBlockIds: ['block-1'],
    expectedVersion: 2,
    before: '修改前',
    after: '修改后',
    reason: '让表述更清晰',
    accepted,
  }
}

function createTask(): AgentTask {
  return {
    id: 'task-1',
    sessionId: 'document-1',
    status: 'waiting_confirmation',
    userInstruction: '优化文档',
    contextScope: 'current_document',
    model: 'test-model',
    currentStep: '修改提案已准备',
    createdAt: 1_000,
    completedAt: null,
    error: null,
  }
}

function createPatchSet(patches: BlockPatch[]): AgentPatchSet {
  return {
    taskId: 'task-1',
    model: 'test-model',
    patches,
    contextSources: [],
    createdAt: 1_100,
  }
}

describe('AgentPatchReviewModal', () => {
  it('renders as a non-modal review region and can collapse without discarding it', async () => {
    const patches = [createPatch()]
    const wrapper = mount(AgentPatchReviewModal, {
      props: {
        show: true,
        task: createTask(),
        patchSet: createPatchSet(patches),
        patches,
        acceptedCount: 1,
      },
    })

    expect(wrapper.find('.ui-dialog-overlay').exists()).toBe(false)
    expect(wrapper.get('aside[aria-label="Agent 修改审阅"]').text()).toContain('修改尚未写入')

    await wrapper.get('button[aria-label="收起修改审阅"]').trigger('click')
    expect(wrapper.emitted('update:show')).toEqual([[false]])
    await wrapper.setProps({ show: false })
    expect(wrapper.find('aside[aria-label="Agent 修改审阅"]').exists()).toBe(false)
    expect(wrapper.get('.agent-review-trigger').text()).toContain('1 项修改待确认')
  })

  it('emits selection and apply actions from the inline panel', async () => {
    const patches = [createPatch()]
    const wrapper = mount(AgentPatchReviewModal, {
      props: {
        show: true,
        task: createTask(),
        patchSet: createPatchSet(patches),
        patches,
        acceptedCount: 1,
      },
    })

    await wrapper.get('input[aria-label="选择修改 1"]').setValue(false)
    await wrapper.get('.agent-patch-panel__footer .ui-button--primary').trigger('click')

    expect(wrapper.emitted('update-accepted')).toEqual([['patch-1', false]])
    expect(wrapper.emitted('apply')).toEqual([[]])
  })
})
