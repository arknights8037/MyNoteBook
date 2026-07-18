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
  it('renders a focusable scroll region for large approval batches', () => {
    const patches = Array.from({ length: 40 }, (_, index) => ({
      ...createPatch(),
      patchId: `patch-${index + 1}`,
      blockId: `block-${index + 1}`,
      targetBlockIds: [`block-${index + 1}`],
    }))
    const wrapper = mount(AgentPatchReviewModal, {
      props: {
        show: true,
        task: createTask(),
        patchSet: createPatchSet(patches),
        patches,
        acceptedCount: patches.length,
        workspace: true,
      },
    })

    const review = wrapper.get('section[aria-label="待审批修改列表"]')
    expect(review.attributes('tabindex')).toBe('0')
    expect(review.findAll('.agent-patch-card')).toHaveLength(40)
    expect(wrapper.get('.agent-patch-panel__footer').text()).toContain('40 / 40')
  })

  it('renders an opaque workspace review surface and can collapse without discarding it', async () => {
    const patches = [createPatch()]
    const wrapper = mount(AgentPatchReviewModal, {
      props: {
        show: true,
        task: createTask(),
        patchSet: createPatchSet(patches),
        patches,
        acceptedCount: 1,
        workspace: true,
      },
    })

    expect(wrapper.find('.agent-patch-backdrop').exists()).toBe(true)
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

  it('uses a dedicated full-content preview for document creation proposals', () => {
    const patches = [createPatch(true)]
    patches[0] = {
      ...patches[0],
      operation: 'create_document',
      documentId: 'new-document',
      documentTitle: '应用概览',
      blockId: '',
      targetBlockIds: [],
      expectedVersion: 0,
      before: '',
      after: '# 应用概览\n\n完整正文',
    }
    const wrapper = mount(AgentPatchReviewModal, {
      props: {
        show: true,
        task: createTask(),
        patchSet: createPatchSet(patches),
        patches,
        acceptedCount: 1,
      },
    })

    expect(wrapper.get('.agent-patch-panel__header').text()).toContain('确认 Agent 创建内容')
    expect(wrapper.get('.agent-creation-preview').text()).toContain('应用概览')
    expect(wrapper.get('textarea[aria-label="编辑待创建的文档正文"]').element.value).toContain(
      '完整正文',
    )
    expect(wrapper.get('.agent-patch-panel__footer .ui-button--primary').text()).toContain(
      '确认创建',
    )
  })

  it('disables creation confirmation while the write is in flight', () => {
    const patches = [
      {
        ...createPatch(),
        operation: 'create_document' as const,
        documentId: 'new-document',
        documentTitle: '应用概览',
        blockId: '',
        targetBlockIds: [],
        expectedVersion: 0,
      },
    ]
    const wrapper = mount(AgentPatchReviewModal, {
      props: {
        show: true,
        task: createTask(),
        patchSet: createPatchSet(patches),
        patches,
        acceptedCount: 1,
        applying: true,
      },
    })

    const confirm = wrapper.get('.agent-patch-panel__footer .ui-button--primary')
    expect(confirm.attributes('disabled')).toBeDefined()
    expect(confirm.text()).toContain('创建中')
  })
})
