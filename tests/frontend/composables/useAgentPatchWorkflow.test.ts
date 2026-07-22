import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useAgentPatchWorkflow, type AgentPatchDocumentSnapshot } from '@/composables/useAgentPatchWorkflow'
import type { AgentPatchSet, AgentTask, BlockPatch } from '@/models/agent/agent'
import type { DocumentRecord, TiptapDocumentJson } from '@/models/documents/document'
import { err, ok, type AppResult } from '@/models/shared/result'
import type { AgentRepository, AppliedAgentPatchSet } from '@/repositories/agent/AgentRepository'

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
      expect.objectContaining({
        batchId: 'transaction-1',
        documents: [expect.objectContaining({ documentId: 'doc-1' })],
      }),
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

  it('prepares all accepted document projections for one atomic repository batch', async () => {
    const secondContent: TiptapDocumentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'block-2' },
          content: [{ type: 'text', text: '第二篇修改前' }],
        },
      ],
    }
    const { workflow, repository } = createWorkflow({
      'doc-2': {
        id: 'doc-2',
        content: secondContent,
        dirty: false,
        revision: 4,
        blocks: [{ id: 'block-2', type: 'paragraph', text: '第二篇修改前', index: 0 }],
      },
    })
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = {
      ...patchSet(),
      patches: [
        patch(),
        patch({
          patchId: 'patch-2',
          documentId: 'doc-2',
          blockId: 'block-2',
          targetBlockIds: ['block-2'],
          expectedVersion: 4,
          before: '第二篇修改前',
          after: '第二篇修改后',
        }),
      ],
    }

    await workflow.applyPendingAgentPatches()

    expect(repository.applyPatchSet).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'transaction-1',
        documents: [
          expect.objectContaining({ documentId: 'doc-1', transactionId: 'transaction-1' }),
          expect.objectContaining({ documentId: 'doc-2', transactionId: 'transaction-1:1' }),
        ],
      }),
    )
  })

  it('restores a pending proposal and recoverable transaction for the current document', async () => {
    const { workflow, repository } = createWorkflow()
    const recoveredTask = task()
    const recoveredPatchSet = patchSet()
    const transaction = {
      id: 'recovered-transaction',
      taskId: recoveredTask.id,
      documentId: 'doc-1',
      beforeRevision: 1,
      resultingRevision: 2,
      status: 'applied' as const,
      createdAt: 100,
      rolledBackAt: null,
    }
    repository.loadRecoveryState.mockResolvedValueOnce(
      ok({
        tasks: [recoveredTask],
        pendingTask: recoveredTask,
        pendingPatchSet: recoveredPatchSet,
        lastAppliedTask: recoveredTask,
        lastAppliedPatchSet: recoveredPatchSet,
        lastAppliedTransaction: transaction,
      }),
    )

    await workflow.restoreForDocument('doc-1')

    expect(workflow.pendingAgentTask.value).toMatchObject({ id: recoveredTask.id })
    expect(workflow.showAgentPatchModal.value).toBe(true)
    expect(workflow.lastAppliedAgentTransactionId.value).toBe('recovered-transaction')
  })

  it('records a rejected proposal as a completed task', async () => {
    const { workflow, repository } = createWorkflow()
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = patchSet()

    await workflow.rejectPendingAgentPatches()

    expect(repository.rejectPatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', currentStep: '用户已拒绝全部修改' }),
      expect.any(Array),
    )
  })

  it('atomically creates a group and its initial document through the creation workflow', async () => {
    const { workflow, repository, mergeDocument, notify } = createWorkflow()
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = groupPatchSet()

    await workflow.applyPendingAgentPatches()

    expect(repository.applyGroupCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ operation: 'create_group', documentId: 'group-1' }),
        childContentJson: expect.any(String),
        childPlainText: expect.stringContaining('初始内容'),
      }),
    )
    expect(mergeDocument).toHaveBeenCalledTimes(2)
    expect(mergeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'group-1', documentKind: 'group' }),
    )
    expect(mergeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'child-1', parentId: 'group-1' }),
    )
    expect(notify.success).toHaveBeenCalledWith('Agent 分组已创建，可用撤销恢复')
  })

  it('keeps a failed creation waiting for confirmation and allows a successful retry', async () => {
    const { workflow, repository, mergeDocument, notify } = createWorkflow()
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = documentCreationPatchSet()
    workflow.showAgentPatchModal.value = true
    repository.applyDocumentCreation
      .mockResolvedValueOnce(
        err({
          code: 'validation-error',
          message: 'Patch creation-patch 的接受内容与结果文档投影不一致。',
        }),
      )
      .mockResolvedValueOnce(
        ok({
          document: documentRecord(1, '正文'),
          createdDocuments: [documentRecord(1, '正文')],
          transaction: {
            id: 'transaction-1',
            taskId: 'task-1',
            documentId: 'new-document',
            beforeRevision: 0,
            resultingRevision: 1,
            status: 'applied',
            createdAt: 100,
            rolledBackAt: null,
          },
        }),
      )

    await workflow.applyPendingAgentPatches()

    expect(workflow.pendingAgentTask.value).toMatchObject({
      status: 'waiting_confirmation',
      currentStep: '写入未完成，可检查后重试',
    })
    expect(workflow.pendingAgentPatchSet.value).not.toBeNull()
    expect(workflow.showAgentPatchModal.value).toBe(true)
    expect(repository.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'waiting_confirmation' }),
    )

    await workflow.applyPendingAgentPatches()

    expect(repository.applyDocumentCreation).toHaveBeenCalledTimes(2)
    expect(workflow.pendingAgentTask.value).toBeNull()
    expect(workflow.pendingAgentPatchSet.value).toBeNull()
    expect(workflow.lastAppliedAgentTask.value).toMatchObject({ status: 'completed', error: null })
    expect(mergeDocument).toHaveBeenCalled()
    expect(notify.success).toHaveBeenCalledWith('Agent 新文档已创建，可用撤销恢复')
  })

  it('ignores duplicate apply clicks while a creation request is in flight', async () => {
    const { workflow, repository } = createWorkflow()
    workflow.pendingAgentTask.value = task()
    workflow.pendingAgentPatchSet.value = documentCreationPatchSet()
    let resolveCreation: ((value: AppResult<AppliedAgentPatchSet>) => void) | undefined
    repository.applyDocumentCreation.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve
      }),
    )

    const firstApply = workflow.applyPendingAgentPatches()
    const duplicateApply = workflow.applyPendingAgentPatches()
    await duplicateApply

    await vi.waitFor(() => expect(repository.applyDocumentCreation).toHaveBeenCalledTimes(1))
    expect(workflow.isApplyingAgentPatches.value).toBe(true)

    resolveCreation?.(
      ok({
        document: documentRecord(1, '正文'),
        createdDocuments: [documentRecord(1, '正文')],
        transaction: {
          id: 'transaction-1',
          taskId: 'task-1',
          documentId: 'new-document',
          beforeRevision: 0,
          resultingRevision: 1,
          status: 'applied',
          createdAt: 100,
          rolledBackAt: null,
        },
      }),
    )
    await firstApply

    expect(workflow.isApplyingAgentPatches.value).toBe(false)
  })
})

function createWorkflow(additionalSnapshots: Record<string, AgentPatchDocumentSnapshot> = {}) {
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
  const groupDocument: DocumentRecord = {
    ...documentRecord(1, ''),
    id: 'group-1',
    documentKind: 'group',
    title: '资料分组',
  }
  const childDocument: DocumentRecord = {
    ...documentRecord(1, '初始内容'),
    id: 'child-1',
    parentId: 'group-1',
    title: '介绍',
  }
  const repository = {
    loadRecoveryState: vi.fn(),
    applyPatchSet: vi.fn().mockResolvedValue(ok(applied)),
    applyDocumentCreation: vi.fn().mockResolvedValue(ok(applied)),
    applyGroupCreation: vi.fn().mockResolvedValue(
      ok({
        document: groupDocument,
        createdDocuments: [groupDocument, childDocument],
        transaction: {
          ...transaction,
          documentId: 'group-1',
          childDocumentId: 'child-1',
          beforeRevision: 0,
          resultingRevision: 1,
        },
      }),
    ),
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
  const mergeDocument = vi.fn()
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
      loadSnapshot: async (documentId) =>
        additionalSnapshots[documentId] ?? {
          id: 'doc-1',
          content,
          dirty: false,
          revision: 1,
          blocks: [{ id: 'block-1', type: 'paragraph', text: '修改前', index: 0 }],
        },
      applyDocument,
      mergeDocument,
      removeDocument: vi.fn(),
    },
    error: ref(''),
    notify,
    createRepository: async () => repository,
    createTransactionId: () => 'transaction-1',
  })
  return { workflow, repository, applyDocument, mergeDocument, notify }
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

function groupPatchSet(): AgentPatchSet {
  return {
    taskId: 'task-1',
    model: 'test-model',
    contextSources: [],
    createdAt: 1,
    patches: [
      {
        patchId: 'group-patch',
        taskId: 'task-1',
        operation: 'create_group',
        documentId: 'group-1',
        blockId: 'child-1',
        targetBlockIds: [],
        expectedVersion: 0,
        before: '介绍',
        after: '# 介绍\n\n初始内容',
        reason: '创建资料分组',
        accepted: true,
        documentTitle: '资料分组',
        parentDocumentId: null,
      },
    ],
  }
}

function documentCreationPatchSet(): AgentPatchSet {
  return {
    taskId: 'task-1',
    model: 'test-model',
    contextSources: [],
    createdAt: 1,
    patches: [
      {
        patchId: 'creation-patch',
        taskId: 'task-1',
        operation: 'create_document',
        documentId: 'new-document',
        blockId: '',
        targetBlockIds: [],
        expectedVersion: 0,
        before: '',
        after: '# 新文档\n\n正文',
        reason: '创建文档',
        accepted: true,
        documentTitle: '新文档',
        parentDocumentId: null,
      },
    ],
  }
}

function patch(overrides: Partial<BlockPatch> = {}): BlockPatch {
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
    ...overrides,
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
