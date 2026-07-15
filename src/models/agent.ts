import type { AiProvider } from './ai'
import { createDefaultExecutionPolicy, type ExecutionPolicy } from './executionPolicy'

export type AgentTaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentPatchOperation =
  | 'replace'
  | 'insert_before'
  | 'insert_after'
  | 'append'
  | 'create_document'
  | 'create_group'

export interface SelectedBlock {
  id: string
  type: string
  text: string
  index: number
}

export interface AgentTask {
  id: string
  sessionId: string
  status: AgentTaskStatus
  userInstruction: string
  contextScope: 'selection' | 'current_block' | 'current_document'
  model: string
  currentStep: string
  createdAt: number
  completedAt: number | null
  error: string | null
  correlationId: string
  causationId: string | null
  executionPolicy: ExecutionPolicy
  contextBundleId: string | null
  provider: AiProvider
  taskRunId: string | null
}

export interface BlockPatch {
  patchId: string
  taskId: string
  operation: AgentPatchOperation
  documentId: string
  blockId: string
  targetBlockIds: string[]
  expectedVersion: number
  before: string
  after: string
  reason: string
  accepted: boolean
  documentTitle?: string
  parentDocumentId?: string | null
}

export interface AgentPatchSet {
  taskId: string
  patches: BlockPatch[]
  model: string
  contextSources: Array<{
    documentId: string
    documentTitle: string
    blockIds: string[]
  }>
  createdAt: number
}

export interface PatchValidationResult {
  ok: boolean
  error: string | null
}

export function validateBlockPatch(
  patch: BlockPatch,
  options: {
    documentId: string
    expectedVersion: number | null
    availableBlockIds: string[]
    currentBlocks?: SelectedBlock[]
  },
): PatchValidationResult {
  if (patch.operation === 'create_document') {
    if (!patch.documentId.trim() || !patch.documentTitle?.trim()) {
      return { ok: false, error: '新文档提案缺少文档 ID 或标题。' }
    }
    if (patch.expectedVersion !== 0 || patch.before || patch.targetBlockIds.length > 0) {
      return { ok: false, error: '新文档提案包含了无效的块版本信息。' }
    }
    if (!patch.after.trim()) return { ok: false, error: '新文档内容为空。' }
    return { ok: true, error: null }
  }

  if (patch.operation === 'create_group') {
    if (!patch.documentId.trim() || !patch.documentTitle?.trim()) {
      return { ok: false, error: '新分组提案缺少分组 ID 或名称。' }
    }
    if (
      patch.expectedVersion !== 0 ||
      patch.targetBlockIds.length > 0 ||
      patch.parentDocumentId !== null
    ) {
      return { ok: false, error: '新分组提案包含了无效的层级或版本信息。' }
    }
    const hasInitialDocument = Boolean(patch.blockId || patch.before || patch.after)
    if (
      hasInitialDocument &&
      (!patch.blockId.trim() || !patch.before.trim() || !patch.after.trim())
    ) {
      return { ok: false, error: '分组的初始文档提案不完整。' }
    }
    return { ok: true, error: null }
  }

  if (patch.documentId !== options.documentId) {
    return { ok: false, error: '补丁目标文档与当前文档不一致。' }
  }

  if (options.expectedVersion === null || patch.expectedVersion !== options.expectedVersion) {
    return { ok: false, error: '文档版本已变化，需要重新生成 Agent 修改。' }
  }

  if (!patch.targetBlockIds.length) {
    return { ok: false, error: '补丁缺少目标块。' }
  }

  const availableBlockIds = new Set(options.availableBlockIds)
  const missingBlockId = patch.targetBlockIds.find((blockId) => !availableBlockIds.has(blockId))
  if (missingBlockId) {
    return { ok: false, error: `目标块 ${missingBlockId} 已不存在，需要重新生成。` }
  }

  const uniqueBlockIds = new Set(patch.targetBlockIds)
  if (uniqueBlockIds.size !== patch.targetBlockIds.length) {
    return { ok: false, error: '补丁目标块重复，已阻止写入。' }
  }

  if (!uniqueBlockIds.has(patch.blockId)) {
    return { ok: false, error: '补丁主目标块不在目标块列表中。' }
  }

  if (patch.operation !== 'replace' && patch.targetBlockIds.length !== 1) {
    return { ok: false, error: '插入补丁只能使用一个稳定锚点块。' }
  }

  if (options.currentBlocks) {
    const currentBlocksById = new Map(options.currentBlocks.map((block) => [block.id, block]))
    const currentBefore = patch.targetBlockIds
      .map((blockId) => currentBlocksById.get(blockId)?.text ?? '')
      .join('\n\n')
    if (normalizePatchText(currentBefore) !== normalizePatchText(patch.before)) {
      return { ok: false, error: '目标块内容已变化，需要重新生成 Agent 修改。' }
    }
  }

  if (!patch.after.trim()) {
    return { ok: false, error: '补丁内容为空，已阻止写入。' }
  }

  if (
    patch.operation === 'replace' &&
    normalizePatchText(patch.before) === normalizePatchText(patch.after)
  ) {
    return { ok: false, error: '补丁修改前后内容相同，无需写入。' }
  }

  return { ok: true, error: null }
}

export function createAgentTask(input: {
  id: string
  sessionId: string
  userInstruction: string
  contextScope: AgentTask['contextScope']
  model: string
  provider?: AiProvider
  executionPolicy?: ExecutionPolicy
  correlationId?: string
  causationId?: string | null
}): AgentTask {
  return {
    id: input.id,
    sessionId: input.sessionId,
    status: 'pending',
    userInstruction: input.userInstruction,
    contextScope: input.contextScope,
    model: input.model,
    currentStep: '准备任务',
    createdAt: Date.now(),
    completedAt: null,
    error: null,
    correlationId: input.correlationId ?? input.id,
    causationId: input.causationId ?? null,
    executionPolicy:
      input.executionPolicy ??
      createDefaultExecutionPolicy({ tokenBudget: 2048, allowedTools: [] }),
    contextBundleId: null,
    provider: input.provider ?? 'openai',
    taskRunId: null,
  }
}

export function normalizePatchText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

/** Picks a conservative candidate scope when the user did not select blocks. */
export function findRelevantBlocksForInstruction(
  instruction: string,
  blocks: SelectedBlock[],
): SelectedBlock[] {
  const terms = Array.from(
    new Set([
      ...(instruction.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []),
      ...Array.from(instruction.matchAll(/[\p{Script=Han}]{2,}/gu), (match) => match[0]),
    ]),
  ).filter((term) => term.length >= 2 && !AGENT_SCOPE_STOP_TERMS.has(term))
  if (terms.length === 0) return []

  const scored = blocks
    .map((block) => {
      const text = block.text.toLocaleLowerCase()
      const score = terms.reduce(
        (total, term) => total + (text.includes(term) ? term.length : 0),
        0,
      )
      return { block, score }
    })
    .filter((item) => item.score > 0)
  const bestScore = Math.max(...scored.map((item) => item.score), 0)
  if (bestScore === 0) return []
  return scored
    .filter((item) => item.score >= Math.max(2, bestScore * 0.55))
    .map((item) => item.block)
}

const AGENT_SCOPE_STOP_TERMS = new Set([
  '修改',
  '页面',
  '文档',
  '内容',
  '事项',
  '完成',
  '更新',
  '一下',
  '请将',
  '帮我',
])
