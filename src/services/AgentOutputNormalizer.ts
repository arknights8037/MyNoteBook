import { z } from 'zod'

import type { AgentRuntimeInput } from './AgentRuntime'
import {
  agentPatchProposalBatchSchema,
  agentWriteCommandSchema,
  type AgentPatchProposal,
  type AgentWriteCommand,
} from './AgentWriteContract'

export const agentOutputSchema = z
  .object({
    outcome: z.enum(['proposal', 'no_change', 'blocked']).default('proposal'),
    commands: z.array(agentWriteCommandSchema).default([]),
    patches: agentPatchProposalBatchSchema.default([]),
    finalAnswer: z.string().default(''),
  })
  .refine(
    (value) =>
      value.outcome !== 'proposal' || value.commands.length > 0 || value.patches.length > 0,
    {
      message: 'outcome 为 proposal 时必须返回至少一个 command 或 patch。',
    },
  )
  .refine(
    (value) =>
      value.outcome === 'proposal' || (value.commands.length === 0 && value.patches.length === 0),
    {
      message: 'outcome 为 no_change 或 blocked 时不能返回 command 或 patch。',
    },
  )
  .refine(
    (value) => {
      const creationCount = value.commands.filter(
        (command) => command.tool === 'create_document' || command.tool === 'create_group',
      ).length
      return (
        creationCount === 0 ||
        (creationCount === 1 && value.commands.length === 1 && value.patches.length === 0)
      )
    },
    { message: 'create_document 或 create_group 必须作为唯一的写入提案。' },
  )

export type AgentOutput = z.infer<typeof agentOutputSchema>

export function resolveAgentOutputChannels(text: string, reasoningText: string) {
  const textOutput = normalizeAgentOutputCandidate(text)
  const reasoningOutput = normalizeAgentOutputCandidate(reasoningText)
  return {
    output: textOutput ?? reasoningOutput,
    reasoningForDisplay: reasoningOutput ? '' : reasoningText.trim(),
  }
}

export function createNaturalAgentTextOutput(value: string): AgentOutput {
  const text = value.trim()
  const looksLikeIncompleteProtocol =
    /^```(?:json)?\s*(?:\{|\[)/i.test(text) ||
    /^(?:\{|\[)/.test(text) ||
    /"(?:outcome|commands|patches|finalAnswer)"\s*:/.test(text)
  if (!text || looksLikeIncompleteProtocol) {
    return agentOutputSchema.parse({
      outcome: 'blocked',
      commands: [],
      patches: [],
      finalAnswer: text
        ? '模型没有完成本次结构化提案；未执行任何写入，请重试。'
        : '模型没有返回最终答复；未执行任何写入，请重试。',
    })
  }
  return agentOutputSchema.parse({
    outcome: 'no_change',
    commands: [],
    patches: [],
    finalAnswer: text.slice(0, 24_000),
  })
}

export function createCapturedProposalOutput(input: {
  commands: AgentWriteCommand[]
  patches: AgentPatchProposal[]
  text: string
  structuredOutput?: AgentOutput | null
}): AgentOutput {
  const plainText = input.text.trim()
  const usablePlainText =
    plainText && !/^\s*(?:```(?:json)?\s*)?\{/i.test(plainText) ? plainText.slice(0, 4_000) : ''
  const hasCreation = input.commands.some(
    (command) => command.tool === 'create_document' || command.tool === 'create_group',
  )
  return agentOutputSchema.parse({
    outcome: 'proposal',
    commands: input.commands,
    patches: input.patches,
    finalAnswer:
      input.structuredOutput?.finalAnswer.trim() ||
      usablePlainText ||
      (hasCreation ? '已生成创建提案，等待确认后写入。' : '已生成修改提案，等待确认后写入。'),
  })
}

export function normalizeAgentOutputCandidate(value: string): AgentOutput | null {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let bestOutput: AgentOutput | null = null
  let bestPriority = -1
  for (const jsonObject of extractBalancedJsonObjects(trimmed)) {
    try {
      const parsedJson = JSON.parse(jsonObject) as Record<string, unknown>
      const normalized = normalizeParsedAgentOutput(parsedJson)
      if (!normalized) continue
      const priority = hasStructuredAgentEnvelope(parsedJson) ? 2 : 1
      if (priority >= bestPriority) {
        bestOutput = normalized
        bestPriority = priority
      }
    } catch {
      // Compatible providers may append explanation after a valid object.
    }
  }
  return bestOutput
}

export function normalizeAgentOutputForTaskIntent(
  output: AgentOutput,
  _prompt: string,
  intent: AgentRuntimeInput['intent'] = 'default',
): AgentOutput {
  if (intent === 'plan' || intent === 'research') {
    return agentOutputSchema.parse({
      outcome: 'no_change',
      commands: [],
      patches: [],
      finalAnswer: output.finalAnswer,
    })
  }
  return output
}

export function parseAiSdkAgentOutput(value: string): AgentOutput {
  const normalized = normalizeAgentOutputCandidate(value)
  if (normalized) return normalized
  throw new Error('Agent 最终输出不符合 Patch schema。')
}

function hasStructuredAgentEnvelope(parsedJson: Record<string, unknown>): boolean {
  const outputObject =
    [parsedJson.result, parsedJson.output, parsedJson.response].find(isRecord) ?? parsedJson
  return [
    'outcome',
    'commands',
    'actions',
    'patches',
    'changes',
    'finalAnswer',
    'final_answer',
  ].some((field) => Object.hasOwn(outputObject, field))
}

function normalizeParsedAgentOutput(parsedJson: Record<string, unknown>): AgentOutput | null {
  const nestedOutput = [parsedJson.result, parsedJson.output, parsedJson.response].find(isRecord)
  const outputObject = nestedOutput ?? parsedJson
  if (
    Object.hasOwn(outputObject, 'tool') ||
    ![
      'outcome',
      'commands',
      'actions',
      'patches',
      'changes',
      'finalAnswer',
      'final_answer',
      'answer',
      'message',
      'content',
      'text',
    ].some((field) => Object.hasOwn(outputObject, field))
  ) {
    return null
  }
  const candidate = { ...outputObject }
  if (!Array.isArray(candidate.commands) && Array.isArray(candidate.actions)) {
    candidate.commands = candidate.actions
  }
  if (!Array.isArray(candidate.patches) && Array.isArray(candidate.changes)) {
    candidate.patches = candidate.changes
  }
  candidate.commands = Array.isArray(candidate.commands) ? candidate.commands : []
  candidate.patches = Array.isArray(candidate.patches) ? candidate.patches : []
  if (typeof candidate.finalAnswer !== 'string') {
    candidate.finalAnswer = firstString(
      candidate.final_answer,
      candidate.answer,
      candidate.message,
      candidate.content,
      candidate.text,
    )
  }
  if (
    candidate.outcome !== 'proposal' &&
    candidate.outcome !== 'no_change' &&
    candidate.outcome !== 'blocked'
  ) {
    candidate.outcome =
      candidate.commands.length > 0 || candidate.patches.length > 0 ? 'proposal' : 'no_change'
  }
  if (candidate.patches.length > 0) {
    candidate.commands = []
    candidate.patches = candidate.patches.map((patch) => {
      if (!patch || typeof patch !== 'object') return patch
      const fields = patch as Record<string, unknown>
      const blockId = firstString(fields.blockId, fields.block_id)
      return {
        ...fields,
        operation: fields.operation === 'update' ? 'replace' : fields.operation,
        blockId,
        targetBlockIds:
          Array.isArray(fields.targetBlockIds) && fields.targetBlockIds.length > 0
            ? fields.targetBlockIds
            : Array.isArray(fields.target_block_ids) && fields.target_block_ids.length > 0
              ? fields.target_block_ids
              : blockId
                ? [blockId]
                : fields.targetBlockIds,
        after:
          typeof fields.after === 'string' && fields.after.length > 0
            ? fields.after
            : typeof fields.value === 'string'
              ? fields.value
              : firstString(fields.new_content, fields.content, fields.after),
      }
    })
  } else {
    candidate.commands = candidate.commands.map((command) => {
      if (!command || typeof command !== 'object') return command
      const fields = command as Record<string, unknown>
      return fields.tool === undefined && typeof fields.type === 'string'
        ? { ...fields, tool: fields.type }
        : fields
    })
  }
  const parsed = agentOutputSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function extractBalancedJsonObjects(value: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"' && depth > 0) {
      inString = true
    } else if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(value.slice(start, index + 1))
        start = -1
      }
    }
  }
  return objects
}

function firstString(...values: unknown[]): string {
  return (
    values.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
    ''
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
