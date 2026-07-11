import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useAgentPatchWorkflow } from './useAgentPatchWorkflow'
import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent'
import type { DocumentRecord, TiptapDocumentJson } from '@/models/document'
import { ok } from '@/models/result'
import type { AgentRepository, AppliedAgentPatchSet } from '@/repositories/AgentRepository'

const content: TiptapDocumentJson = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'block-1' },
      content: [{ type: 'text', text: '修改前' }],
    },
  ],
}

describe('useAgentPatchWorkflow', () => {
  it('owns patch selection and edited proposal content', () => {
    const { workflow } = createWorkflow()
    workflow.pendingAgentPatchSet.value = patchSet()

    workflow.toggleAgentPatchAccepted('patch-1', false)
    workflow.updateAgentPatchAfter('patch-1', '人工调整后')

    expect(workflow.pendingAgentAcceptedPatches.value).toHaveLength(0)
    expect(workflow.pendingAgentPatches.value[0]?.after).toBe('人工调整后')
  })

  it('validates, persists and commits an accepted patch through the document adapter', async () => {
    const { workflow, repository, applyDocument, notify } = createWorkflow()
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = patchSet()

    await workflow.applyPendingAgentPatches()

    expect(repository.applyPatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'transaction-1' }),
    )
    expect(applyDocument).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
    expect(workflow.pendingAgentPatchSet.value).toBeNull()
    expect(workflow.lastAppliedAgentTask.value?.status).toBe('completed')
    expect(notify.success).toHaveBeenCalledWith('Agent 修改已写入，可用撤销恢复')
  })

  it('rolls back the last applied transaction through the same adapter', async () => {
    const { workflow, repository, applyDocument, notify } = createWorkflow()
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = patchSet()
    await workflow.applyPendingAgentPatches()

    await workflow.rollbackLastAgentTask()

    expect(repository.rollbackTransaction).toHaveBeenCalledWith('transaction-1')
    expect(applyDocument).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }))
    expect(workflow.lastAppliedAgentTask.value).toBeNull()
    expect(notify.success).toHaveBeenLastCalledWith('已撤销最近一次 Agent 修改')
  })
})

function createWorkflow() {
  const appliedDocument = documentRecord(2, '修改后')
  const rolledBackDocument = documentRecord(1, '修改前')
  const transaction = {
    id: 'transaction-1',
    taskId: 'task-1',
    documentId: 'doc-1',
    beforeRevision: 1,
    resultingRevision: 2,
    status: 'applied' as const,
    createdAt: 100,
    rolledBackAt: null,
  }
  const applied: AppliedAgentPatchSet = { document: appliedDocument, transaction }
  const repository = {
    applyPatchSet: vi.fn().mockResolvedValue(ok(applied)),
    rollbackTransaction: vi.fn().mockResolvedValue(
      ok({
        document: rolledBackDocument,
        transaction: { ...transaction, status: 'rolled_back', rolledBackAt: 200 },
      }),
    ),
    rejectPatchSet: vi.fn().mockImplementation(async (nextTask) => ok(nextTask)),
    updateTask: vi.fn().mockImplementation(async (nextTask) => ok(nextTask)),
  } as unknown as AgentRepository
  const applyDocument = vi.fn()
  const notify = { success: vi.fn(), error: vi.fn() }
  const workflow = useAgentPatchWorkflow({
    document: {
      getSnapshot: () => ({
        id: 'doc-1',
        content,
        dirty: false,
        revision: 1,
        blocks: [{ id: 'block-1', type: 'paragraph', text: '修改前', index: 0 }],
      }),
      applyDocument,
      mergeDocument: vi.fn(),
      removeDocument: vi.fn(),
    },
    error: ref(''),
    notify,
    createRepository: async () => repository,
    createTransactionId: () => 'transaction-1',
  })
  return { workflow, repository, applyDocument, notify }
}

function task(): AgentTask {
  return {
    id: 'task-1',
    sessionId: 'doc-1',
    status: 'waiting_confirmation',
    userInstruction: '修改正文',
    contextScope: 'current_block',
    model: 'test-model',
    currentStep: '等待确认',
    createdAt: 1,
    completedAt: null,
    error: null,
  }
}

function patchSet(): AgentPatchSet {
  return {
    taskId: 'task-1',
    patches: [patch()],
    model: 'test-model',
    contextSources: [],
    createdAt: 1,
  }
}

function patch(): BlockPatch {
  return {
    patchId: 'patch-1',
    taskId: 'task-1',
    operation: 'replace',
    documentId: 'doc-1',
    blockId: 'block-1',
    targetBlockIds: ['block-1'],
    expectedVersion: 1,
    before: '修改前',
    after: '修改后',
    reason: '测试',
    accepted: true,
  }
}

function documentRecord(revision: number, plainText: string): DocumentRecord {
  return {
    id: 'doc-1',
    parentId: null,
    documentKind: 'article',
    title: '测试文档',
    tags: [],
    sourceUrl: '',
    author: '',
    description: '',
    contentJson: JSON.stringify(content),
    plainText,
    schemaVersion: 2,
    revision,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
