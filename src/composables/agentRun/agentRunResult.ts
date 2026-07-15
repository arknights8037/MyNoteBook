import type { AgentPatchSet, AgentTask, SelectedBlock } from '@/models/agent'
import type { KnowledgeSource } from '@/models/knowledgeRetrieval'
import type { AiChatMode } from '@/models/aiChatMode'
import {
  createAgentCommandPatches,
  type RegexReplaceExecutor,
} from '@/services/AgentCommandService'
import { parseAgentResponse } from '@/services/AgentProtocol'
import { normalizeDocumentTitle } from '@/features/documents/documentPresentation'
import type { AgentRunSnapshot } from './types'

export type AgentRunOutcome = 'proposal' | 'no_change' | 'blocked'

export interface AgentRunResult {
  patchSet: AgentPatchSet | null
  summary: string
  outcome: AgentRunOutcome
}
export async function resolveAgentRunResult(input: {
  output: string
  mode: Extract<AiChatMode, 'edit' | 'agent'>
  task: AgentTask
  snapshot: AgentRunSnapshot
  expectedRevision: number
  targetBlocks: SelectedBlock[]
  readableDocuments?: Array<{
    documentId: string
    documentTitle: string
    expectedVersion: number
    blocks: SelectedBlock[]
  }>
  sources: KnowledgeSource[]
  usesSelection: boolean
  foundTargetScope: boolean
  replaceBlocksByRegex: RegexReplaceExecutor
  createId: () => string
}): Promise<AgentRunResult> {
  const contextSources = [
    {
      documentId: input.snapshot.document.id,
      documentTitle: normalizeDocumentTitle(input.snapshot.document.title),
      blockIds: input.targetBlocks.map((block) => block.id),
    },
    ...input.sources
      .filter((source) => source.documentId !== input.snapshot.document.id)
      .map((source) => ({
        documentId: source.documentId,
        documentTitle: source.documentTitle,
        blockIds: source.blockId ? [source.blockId] : [],
      })),
    ...(input.readableDocuments ?? [])
      .filter((source) => source.documentId !== input.snapshot.document.id)
      .map((source) => ({
        documentId: source.documentId,
        documentTitle: source.documentTitle,
        blockIds: source.blocks.map((block) => block.id),
      })),
  ]
  const parsed = parseAgentResponse({
    output: input.output,
    task: input.task,
    documentId: input.snapshot.document.id,
    expectedRevision: input.expectedRevision,
    targetBlocks: input.targetBlocks,
    readableDocuments: input.readableDocuments,
    contextSources,
    createId: input.createId,
    allowMarkdownFallback: input.mode === 'edit' || input.usesSelection || input.foundTargetScope,
  })
  let patchSet = parsed.patchSet
  if (parsed.commands.length > 0) {
    if (
      parsed.commands.some(
        (command) => command.tool === 'create_document' || command.tool === 'create_group',
      ) &&
      (parsed.commands.length > 1 || parsed.patchSet)
    ) {
      throw new Error('新建文档或分组不能和其他修改混在同一批提案中。')
    }
    const commandPatches = (
      await Promise.all(
        parsed.commands.map((command) =>
          createAgentCommandPatches({
            command,
            taskId: input.task.id,
            documentId: input.snapshot.document.id,
            expectedVersion: input.expectedRevision,
            blocks: input.targetBlocks,
            readableDocuments: input.readableDocuments,
            allowedParentDocumentIds: input.snapshot.document.documents
              .filter((document) => document.documentKind === 'group' && !document.isDeleted)
              .map((document) => document.id),
            replaceBlocksByRegex: input.replaceBlocksByRegex,
            createId: input.createId,
          }),
        ),
      )
    ).flat()
    patchSet = commandPatches.length
      ? {
          taskId: input.task.id,
          patches: commandPatches,
          model: input.task.model,
          contextSources: parsed.patchSet?.contextSources ?? contextSources,
          createdAt: Date.now(),
        }
      : null
  }
  if (!patchSet && parsed.outcome === 'proposal') {
    throw new Error('Agent 未返回有效的结构化 Patch。')
  }
  if (patchSet) assertDisjointPatchTargets(patchSet)
  return { patchSet, summary: parsed.finalAnswer, outcome: parsed.outcome }
}

function assertDisjointPatchTargets(patchSet: AgentPatchSet): void {
  const targetedBlocks = new Set<string>()
  for (const patch of patchSet.patches) {
    if (patch.operation === 'create_document' || patch.operation === 'create_group') continue
    if (new Set(patch.targetBlockIds).size !== patch.targetBlockIds.length) {
      throw new Error('单个补丁不能重复声明同一个目标块。')
    }
    if (!patch.targetBlockIds.includes(patch.blockId)) {
      throw new Error('补丁锚点块必须包含在目标块列表中。')
    }
    if (patch.operation !== 'replace' && patch.targetBlockIds.length !== 1) {
      throw new Error('插入补丁只能使用一个稳定锚点块。')
    }
    for (const blockId of patch.targetBlockIds) {
      const key = `${patch.documentId}:${blockId}`
      if (targetedBlocks.has(key)) {
        throw new Error('多个补丁不能修改同一个目标块；请合并为一个补丁后重试。')
      }
      targetedBlocks.add(key)
    }
  }
}

export function formatAgentRunSummary(input: {
  summary: string
  outcome: AgentRunOutcome
  patchCount: number
  rounds?: number
  toolCallCount?: number
}): string {
  const summary =
    input.summary ||
    (input.outcome === 'proposal'
      ? `已生成 ${input.patchCount} 项修改，等待确认。`
      : input.outcome === 'blocked'
        ? '现有信息不足，暂时没有生成修改。'
        : '当前内容无需修改。')
  const report =
    (input.toolCallCount ?? 0) > 0
      ? `\n\n已完成 ${input.toolCallCount} 次工具调用，共进行 ${input.rounds ?? 0} 轮处理。`
      : ''
  return `${summary}${report}`
}
