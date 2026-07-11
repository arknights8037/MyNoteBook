import type { AgentPatchSet, AgentTask, SelectedBlock } from '@/models/agent'
import type { KnowledgeSource } from '@/models/knowledgeRetrieval'
import type { AiChatMode } from '@/models/aiChatMode'
import { createAgentCommandPatches } from '@/services/AgentCommandService'
import { parseAgentResponse } from '@/services/AgentProtocol'
import { normalizeDocumentTitle } from '@/features/documents/documentPresentation'
import type { AgentRunSnapshot } from './types'

export type AgentRunOutcome = 'proposal' | 'no_change' | 'blocked'

export interface AgentRunResult {
  patchSet: AgentPatchSet | null
  summary: string
  outcome: AgentRunOutcome
}
export function resolveAgentRunResult(input: {
  output: string
  mode: Extract<AiChatMode, 'edit' | 'agent'>
  task: AgentTask
  snapshot: AgentRunSnapshot
  expectedRevision: number
  targetBlocks: SelectedBlock[]
  sources: KnowledgeSource[]
  usesSelection: boolean
  foundTargetScope: boolean
  createId: () => string
}): AgentRunResult {
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
  ]
  const parsed = parseAgentResponse({
    output: input.output,
    task: input.task,
    documentId: input.snapshot.document.id,
    expectedRevision: input.expectedRevision,
    targetBlocks: input.targetBlocks,
    contextSources,
    createId: input.createId,
    allowMarkdownFallback:
      input.mode === 'edit' || input.usesSelection || input.foundTargetScope,
  })
  let patchSet = parsed.patchSet
  if (parsed.commands.length > 0) {
    if (
      parsed.commands.some((command) => command.tool === 'create_document') &&
      (parsed.commands.length > 1 || parsed.patchSet)
    ) {
      throw new Error('新建文档不能和其他修改混在同一批提案中。')
    }
    const commandPatches = parsed.commands.flatMap((command) =>
      createAgentCommandPatches({
        command,
        taskId: input.task.id,
        documentId: input.snapshot.document.id,
        expectedVersion: input.expectedRevision,
        blocks: input.targetBlocks,
        createId: input.createId,
      }),
    )
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
  return { patchSet, summary: parsed.finalAnswer, outcome: parsed.outcome }
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
      ? `\n\n已查阅 ${input.toolCallCount} 次资料，共完成 ${input.rounds ?? 0} 轮处理。`
      : ''
  return `${summary}${report}`
}
