import { computed, ref, type Ref } from 'vue'

import { applyAgentBlockPatches } from '@/editor/agentBlockPatch'
import { parseMarkdownDocument } from '@/editor/markdownImport'
import {
  validateBlockPatch,
  type AgentPatchSet,
  type AgentTask,
  type SelectedBlock,
} from '@/models/agent'
import type { DocumentId, DocumentRecord, TiptapDocumentJson } from '@/models/document'
import { createEntityId } from '@/models/id'
import type { AgentRepository } from '@/repositories/AgentRepository'
import { createAgentRepository } from '@/infrastructure/database/agentRepositoryFactory'

export interface AgentPatchDocumentSnapshot {
  id: DocumentId
  content: TiptapDocumentJson
  dirty: boolean
  revision: number | null
  blocks: SelectedBlock[]
}

export interface AgentPatchDocumentAdapter {
  getSnapshot: () => AgentPatchDocumentSnapshot
  applyDocument: (document: DocumentRecord) => void
  mergeDocument: (document: DocumentRecord) => void
  removeDocument: (documentId: DocumentId) => void
}

export interface AgentPatchWorkflowNotifier {
  success: (message: string) => void
  error: (message: string) => void
}

export interface UseAgentPatchWorkflowOptions {
  document: AgentPatchDocumentAdapter
  error: Ref<string>
  notify: AgentPatchWorkflowNotifier
  createRepository?: () => Promise<AgentRepository>
  createTransactionId?: () => string
}

export function useAgentPatchWorkflow(options: UseAgentPatchWorkflowOptions) {
  const pendingAgentTask = ref<AgentTask | null>(null)
  const pendingAgentPatchSet = ref<AgentPatchSet | null>(null)
  const showAgentPatchModal = ref(false)
  const lastAppliedAgentTask = ref<AgentTask | null>(null)
  const lastAppliedPatchSet = ref<AgentPatchSet | null>(null)
  const lastAppliedAgentTransactionId = ref<string | null>(null)
  const pendingAgentPatches = computed(() => pendingAgentPatchSet.value?.patches ?? [])
  const pendingAgentAcceptedPatches = computed(() =>
    pendingAgentPatches.value.filter((patch) => patch.accepted),
  )
  const createTransactionId = options.createTransactionId ?? (() => createEntityId('transaction'))

  async function getAgentRepository(): Promise<AgentRepository> {
    return (options.createRepository ?? createAgentRepository)()
  }

  function toggleAgentPatchAccepted(patchId: string, accepted: boolean): void {
    const patch = pendingAgentPatchSet.value?.patches.find(
      (candidate) => candidate.patchId === patchId,
    )
    if (patch) patch.accepted = accepted
  }

  function updateAgentPatchAfter(patchId: string, content: string): void {
    const patch = pendingAgentPatchSet.value?.patches.find(
      (candidate) => candidate.patchId === patchId,
    )
    if (patch) patch.after = content
  }

  function setAllPendingAgentPatchesAccepted(accepted: boolean): void {
    for (const patch of pendingAgentPatches.value) patch.accepted = accepted
  }

  async function acceptAllPendingAgentPatches(): Promise<void> {
    setAllPendingAgentPatchesAccepted(true)
    await applyPendingAgentPatches()
  }

  async function rejectPendingAgentPatches(): Promise<void> {
    if (pendingAgentTask.value) {
      pendingAgentTask.value.status = 'cancelled'
      pendingAgentTask.value.currentStep = '用户已拒绝修改'
      pendingAgentTask.value.completedAt = Date.now()
      const repository = await getAgentRepository()
      const rejected = await repository.rejectPatchSet(
        pendingAgentTask.value,
        pendingAgentPatchSet.value?.patches ?? [],
      )
      if (!rejected.ok) {
        options.notify.error(rejected.error.message)
        return
      }
    }
    pendingAgentTask.value = null
    pendingAgentPatchSet.value = null
    showAgentPatchModal.value = false
    options.notify.success('已拒绝 Agent 修改')
  }

  async function applyPendingAgentPatches(): Promise<void> {
    const task = pendingAgentTask.value
    const patchSet = pendingAgentPatchSet.value
    if (!task || !patchSet) return

    const acceptedPatches = patchSet.patches.filter((patch) => patch.accepted)
    if (acceptedPatches.length === 0) {
      await rejectPendingAgentPatches()
      return
    }

    const snapshot = options.document.getSnapshot()
    if (snapshot.dirty) {
      failPendingAgentTask('文档已有未保存改动，请保存后重新生成 Agent 修改。')
      return
    }

    const availableBlockIds = snapshot.blocks.map((block) => block.id)
    for (const patch of acceptedPatches) {
      const validation = validateBlockPatch(patch, {
        documentId: snapshot.id,
        expectedVersion: snapshot.revision,
        availableBlockIds,
        currentBlocks: snapshot.blocks,
      })
      if (!validation.ok) {
        failPendingAgentTask(validation.error ?? '补丁校验失败。')
        return
      }
    }

    const creationPatches = acceptedPatches.filter((patch) => patch.operation === 'create_document')
    if (creationPatches.length > 0) {
      if (creationPatches.length !== 1 || acceptedPatches.length !== 1) {
        failPendingAgentTask('新建文档必须作为独立提案确认。')
        return
      }
      const creationPatch = creationPatches[0]
      if (!creationPatch) return
      const imported = parseMarkdownDocument(
        creationPatch.after,
        creationPatch.documentTitle || 'Agent 新建文档',
      )
      const repository = await getAgentRepository()
      const applied = await repository.applyDocumentCreation({
        task,
        patchSet,
        patch: creationPatch,
        contentJson: JSON.stringify(imported.content),
        plainText: imported.plainText,
        transactionId: createTransactionId(),
      })
      if (!applied.ok || !applied.value.document) {
        failPendingAgentTask(applied.ok ? '新文档创建后无法读取。' : applied.error.message)
        return
      }
      options.document.mergeDocument(applied.value.document)
      completeTask(task, patchSet, applied.value.transaction.id, applied.value.transaction.createdAt)
      options.notify.success('Agent 新文档已创建，可用撤销恢复')
      return
    }

    const nextContent = applyAgentBlockPatches(snapshot.content, acceptedPatches)
    if (!nextContent.ok || !nextContent.content || nextContent.plainText === undefined) {
      failPendingAgentTask(nextContent.error ?? '无法生成 Agent 修改后的文档内容。')
      return
    }

    const repository = await getAgentRepository()
    const applied = await repository.applyPatchSet({
      task,
      patchSet,
      acceptedPatches,
      contentJson: JSON.stringify(nextContent.content),
      plainText: nextContent.plainText,
      transactionId: createTransactionId(),
    })
    if (!applied.ok || !applied.value.document) {
      failPendingAgentTask(applied.ok ? 'Agent 修改完成后无法读取目标文档。' : applied.error.message)
      return
    }
    options.document.applyDocument(applied.value.document)
    completeTask(task, patchSet, applied.value.transaction.id, applied.value.transaction.createdAt)
    options.notify.success('Agent 修改已写入，可用撤销恢复')
  }

  function completeTask(
    task: AgentTask,
    patchSet: AgentPatchSet,
    transactionId: string,
    completedAt: number,
  ): void {
    task.status = 'completed'
    task.currentStep = patchSet.patches.some((patch) => patch.operation === 'create_document')
      ? '新文档已创建'
      : '修改已写入文档'
    task.completedAt = completedAt
    lastAppliedAgentTask.value = task
    lastAppliedPatchSet.value = patchSet
    lastAppliedAgentTransactionId.value = transactionId
    pendingAgentTask.value = null
    pendingAgentPatchSet.value = null
    showAgentPatchModal.value = false
  }

  function failPendingAgentTask(error: string): void {
    if (pendingAgentTask.value) {
      pendingAgentTask.value.status = 'failed'
      pendingAgentTask.value.currentStep = '补丁校验失败'
      pendingAgentTask.value.completedAt = Date.now()
      pendingAgentTask.value.error = error
      void updateAgentTaskPersistence(pendingAgentTask.value)
    }
    options.error.value = error
    options.notify.error(error)
  }

  async function rollbackLastAgentTask(): Promise<void> {
    const task = lastAppliedAgentTask.value
    const patchSet = lastAppliedPatchSet.value
    const transactionId = lastAppliedAgentTransactionId.value
    if (!task || !patchSet || !transactionId) return
    if (task.sessionId !== options.document.getSnapshot().id) {
      options.notify.error('请先打开 Agent 修改所在的文档，再执行撤销。')
      return
    }
    const repository = await getAgentRepository()
    const rolledBack = await repository.rollbackTransaction(transactionId)
    if (!rolledBack.ok) {
      options.notify.error(rolledBack.error.message)
      return
    }
    if (rolledBack.value.document) {
      options.document.applyDocument(rolledBack.value.document)
    } else {
      options.document.removeDocument(rolledBack.value.transaction.documentId)
    }
    lastAppliedAgentTask.value = null
    lastAppliedPatchSet.value = null
    lastAppliedAgentTransactionId.value = null
    options.notify.success('已撤销最近一次 Agent 修改')
  }

  async function updateAgentTaskPersistence(task: AgentTask): Promise<void> {
    const repository = await getAgentRepository()
    await repository.updateTask(task)
  }

  return {
    pendingAgentTask,
    pendingAgentPatchSet,
    pendingAgentPatches,
    pendingAgentAcceptedPatches,
    showAgentPatchModal,
    lastAppliedAgentTask,
    lastAppliedPatchSet,
    lastAppliedAgentTransactionId,
    toggleAgentPatchAccepted,
    updateAgentPatchAfter,
    setAllPendingAgentPatchesAccepted,
    acceptAllPendingAgentPatches,
    rejectPendingAgentPatches,
    applyPendingAgentPatches,
    failPendingAgentTask,
    rollbackLastAgentTask,
    getAgentRepository,
    updateAgentTaskPersistence,
  }
}
