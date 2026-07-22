import type {
  AgentPatchOperation,
  AgentPatchSet,
  AgentTask,
  BlockPatch,
  SelectedBlock,
} from '@/models/agent/agent'
import { parseAgentWriteCommands, type AgentWriteCommand } from '@/services/agent/AgentWriteContract'

interface ModelPatch {
  documentId?: unknown
  operation?: unknown
  blockId?: unknown
  targetBlockIds?: unknown
  after?: unknown
  reason?: unknown
}

interface ModelResponse {
  outcome?: unknown
  patches?: unknown
  commands?: unknown
  toolCalls?: unknown
  finalAnswer?: unknown
}

export interface ParsedAgentResponse {
  outcome: 'proposal' | 'no_change' | 'blocked'
  patchSet: AgentPatchSet | null
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  commands: AgentWriteCommand[]
  finalAnswer: string
  usedMarkdownFallback: boolean
}

export function parseAgentToolCalls(
  output: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  return parseToolCalls(parseJsonPayload(output)?.toolCalls)
}

export function hasAgentFinalAction(output: string): boolean {
  const parsed = parseJsonPayload(output)
  if (!parsed) return false
  return (
    (Array.isArray(parsed.commands) && parsed.commands.length > 0) ||
    (Array.isArray(parsed.patches) && parsed.patches.length > 0)
  )
}

export function parseAgentResponse(input: {
  output: string
  task: AgentTask
  documentId: string
  expectedRevision: number
  targetBlocks: SelectedBlock[]
  readableDocuments?: Array<{
    documentId: string
    expectedVersion: number
    blocks: SelectedBlock[]
  }>
  contextSources: AgentPatchSet['contextSources']
  createId: () => string
  allowMarkdownFallback?: boolean
}): ParsedAgentResponse {
  const parsed = parseJsonPayload(input.output)
  if (!parsed) {
    return {
      patchSet:
        input.allowMarkdownFallback === false ? null : createMarkdownFallbackPatchSet(input),
      outcome: 'proposal',
      toolCalls: [],
      commands: [],
      finalAnswer: input.output.trim(),
      usedMarkdownFallback: true,
    }
  }

  const patches = Array.isArray(parsed.patches)
    ? parsed.patches
        .map((value) => createPatch(value, input))
        .filter((patch): patch is BlockPatch => patch !== null)
    : []
  return {
    outcome: readOutcome(parsed.outcome),
    patchSet: patches.length
      ? {
          taskId: input.task.id,
          patches,
          model: input.task.model,
          contextSources: input.contextSources,
          createdAt: Date.now(),
        }
      : null,
    toolCalls: parseToolCalls(parsed.toolCalls),
    commands: parseAgentWriteCommands(parsed.commands),
    finalAnswer: typeof parsed.finalAnswer === 'string' ? parsed.finalAnswer.trim() : '',
    usedMarkdownFallback: false,
  }
}

function readOutcome(value: unknown): ParsedAgentResponse['outcome'] {
  return value === 'no_change' || value === 'blocked' ? value : 'proposal'
}

function createMarkdownFallbackPatchSet(
  input: Parameters<typeof parseAgentResponse>[0],
): AgentPatchSet | null {
  const after = input.output.trim()
  const targetBlockIds = input.targetBlocks.map((block) => block.id)
  if (!after || targetBlockIds.length === 0) return null

  return {
    taskId: input.task.id,
    model: input.task.model,
    contextSources: input.contextSources,
    createdAt: Date.now(),
    patches: [
      {
        patchId: input.createId(),
        taskId: input.task.id,
        operation: 'replace',
        documentId: input.documentId,
        blockId: targetBlockIds[0] ?? '',
        targetBlockIds,
        expectedVersion: input.expectedRevision,
        before: input.targetBlocks.map((block) => block.text).join('\n\n'),
        after,
        reason: '模型未返回结构化 Patch，已降级为单个待确认的替换建议。',
        accepted: true,
      },
    ],
  }
}

function createPatch(
  value: unknown,
  input: Parameters<typeof parseAgentResponse>[0],
): BlockPatch | null {
  if (!value || typeof value !== 'object') return null
  const modelPatch = value as ModelPatch
  const operation = readOperation(modelPatch.operation)
  const requestedDocumentId =
    typeof modelPatch.documentId === 'string' && modelPatch.documentId.trim()
      ? modelPatch.documentId
      : input.documentId
  const scope =
    input.readableDocuments?.find((document) => document.documentId === requestedDocumentId) ??
    (requestedDocumentId === input.documentId
      ? {
          documentId: input.documentId,
          expectedVersion: input.expectedRevision,
          blocks: input.targetBlocks,
        }
      : undefined)
  if (!scope) return null
  const fallbackIds = scope.blocks.map((block) => block.id)
  const targetBlockIds = Array.isArray(modelPatch.targetBlockIds)
    ? modelPatch.targetBlockIds.filter(
        (id): id is string => typeof id === 'string' && Boolean(id.trim()),
      )
    : fallbackIds
  const requestedBlockId =
    typeof modelPatch.blockId === 'string' ? modelPatch.blockId : targetBlockIds[0]
  const blockId =
    requestedBlockId && targetBlockIds.includes(requestedBlockId)
      ? requestedBlockId
      : targetBlockIds[0]
  if (targetBlockIds.some((id) => !scope.blocks.some((block) => block.id === id))) return null
  const before = scope.blocks
    .filter((block) => targetBlockIds.includes(block.id))
    .map((block) => block.text)
    .join('\n\n')
  if (!operation || !blockId || targetBlockIds.length === 0 || typeof modelPatch.after !== 'string')
    return null
  return {
    patchId: input.createId(),
    taskId: input.task.id,
    operation,
    documentId: scope.documentId,
    blockId,
    targetBlockIds,
    expectedVersion: scope.expectedVersion,
    before,
    after: modelPatch.after.trim(),
    reason:
      typeof modelPatch.reason === 'string' ? modelPatch.reason.trim() : 'Agent 生成的结构化修改。',
    accepted: true,
  }
}

function readOperation(value: unknown): AgentPatchOperation | null {
  return value === 'replace' ||
    value === 'insert_before' ||
    value === 'insert_after' ||
    value === 'append'
    ? value
    : null
}

function parseToolCalls(
  value: unknown,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!call || typeof call !== 'object') return []
    const candidate = call as { name?: unknown; arguments?: unknown }
    if (typeof candidate.name !== 'string') return []
    return [
      { name: candidate.name, arguments: isRecord(candidate.arguments) ? candidate.arguments : {} },
    ]
  })
}

function parseJsonPayload(output: string): ModelResponse | null {
  const trimmed = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const value = JSON.parse(trimmed) as unknown
    return isRecord(value) ? (value as ModelResponse) : null
  } catch {
    const embeddedJson = extractJsonObject(trimmed)
    if (!embeddedJson) return null
    try {
      const value = JSON.parse(embeddedJson) as unknown
      return isRecord(value) ? (value as ModelResponse) : null
    } catch {
      return null
    }
  }
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
