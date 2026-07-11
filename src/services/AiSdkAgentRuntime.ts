import { generateText, NoObjectGeneratedError, Output, ToolLoopAgent, stepCountIs, tool } from 'ai'
import { z } from 'zod'

import type { AgentToolCall } from '@/models/agentTool'
import { createAiSdkModel } from './AiSdkProvider'
import {
  AGENT_MAX_TASK_DURATION_MS,
  AGENT_MAX_TOOL_FAILURES,
  AGENT_MAX_TOOL_ROUNDS,
  getAgentToolDefinition,
} from './AgentToolRegistry'
import type { AgentRuntimeInput, AgentRuntimeResult } from './AgentRuntime'

const regexCommandSchema = z.object({
  tool: z.literal('replace_text_by_regex'),
  pattern: z.string(),
  replacement: z.string(),
  flags: z.string().optional(),
  blockIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
})

const commandSchema = z.discriminatedUnion('tool', [
  regexCommandSchema,
  z.object({
    tool: z.literal('replace_block'),
    blockId: z.string().min(1),
    content: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    tool: z.literal('insert_blocks'),
    anchorBlockId: z.string().min(1),
    position: z.enum(['before', 'after', 'append']),
    content: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    tool: z.literal('create_document'),
    title: z.string().min(1),
    content: z.string().min(1),
    parentDocumentId: z.string().nullable().optional(),
    reason: z.string().optional(),
  }),
])

const patchSchema = z.object({
  operation: z.enum(['replace', 'insert_before', 'insert_after', 'append']),
  blockId: z.string(),
  targetBlockIds: z.array(z.string()).min(1),
  after: z.string().min(1),
  reason: z.string().min(1),
})

const agentOutputSchema = z
  .object({
    outcome: z.enum(['proposal', 'no_change', 'blocked']).default('proposal'),
    commands: z.array(commandSchema).default([]),
    patches: z.array(patchSchema).default([]),
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
        (command) => command.tool === 'create_document',
      ).length
      return (
        creationCount === 0 ||
        (creationCount === 1 && value.commands.length === 1 && value.patches.length === 0)
      )
    },
    { message: 'create_document 必须作为唯一的写入提案。' },
  )

export async function runAiSdkAgent(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const calls: AgentToolCall[] = []
  const callCounts = new Map<string, number>()
  let failures = 0

  const execute = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const startedAt = Date.now()
    input.onProgress?.({
      phase: 'tool_running',
      toolName: name,
      detail: getToolProgressLabel(name, false),
    })
    const definition = getAgentToolDefinition(name)
    const nextCount = (callCounts.get(name) ?? 0) + 1
    callCounts.set(name, nextCount)
    let execution
    if (!definition || definition.risk !== 'read') {
      execution = { ok: false, error: `工具 ${name} 不允许在 Agent loop 中执行。` }
    } else if (nextCount > definition.maxCallsPerTask) {
      execution = { ok: false, error: `工具 ${name} 超过单任务调用上限。` }
    } else {
      execution = await input.executeTool({ name, arguments: args })
    }
    const call: AgentToolCall = {
      id: input.createId(),
      taskId: input.taskId,
      toolName: name,
      argumentsJson: JSON.stringify(args),
      resultJson: execution.ok ? safeJson(execution.value) : null,
      status: execution.ok ? 'completed' : 'failed',
      startedAt,
      completedAt: Date.now(),
      error: execution.error ?? null,
    }
    calls.push(call)
    await input.recordToolCall(call)
    if (!execution.ok) {
      failures += 1
      if (failures > AGENT_MAX_TOOL_FAILURES) throw new Error('Agent 工具失败次数超过上限。')
      return { ok: false, error: execution.error }
    }
    input.onProgress?.({
      phase: 'tool_completed',
      toolName: name,
      detail: getToolProgressLabel(name, true),
    })
    return execution.value
  }

  const tools = {
    get_current_document: tool({
      description: '读取当前文档、revision 和稳定块。',
      inputSchema: z.object({}),
      execute: (args) => execute('get_current_document', args),
    }),
    get_selected_blocks: tool({
      description: '读取用户真实选择的块；没有选区时返回空数组。',
      inputSchema: z.object({}),
      execute: (args) => execute('get_selected_blocks', args),
    }),
    get_document_outline: tool({
      description: '读取当前文档标题大纲及稳定 block id。',
      inputSchema: z.object({}),
      execute: (args) => execute('get_document_outline', args),
    }),
    search_documents: tool({
      description: '搜索本地知识库，返回文档 ID、标题、片段和 revision。',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: (args) => execute('search_documents', args),
    }),
    read_document: tool({
      description: '按文档 ID 读取知识库文档正文、标签和 revision。',
      inputSchema: z.object({ documentId: z.string().min(1) }),
      execute: (args) => execute('read_document', args),
    }),
    find_blocks_by_regex: tool({
      description: '使用受限正则表达式定位当前文档中的块。',
      inputSchema: z.object({ pattern: z.string().min(1).max(240), flags: z.string().optional() }),
      execute: (args) => execute('find_blocks_by_regex', args),
    }),
  }

  const agent = new ToolLoopAgent({
    model: createAiSdkModel(input.settings),
    instructions: [
      input.systemPrompt,
      '协议要求：最终响应必须是符合给定 schema 的单个 JSON 对象。不要添加 JSON 之外的文字。',
      '复杂改写的唯一合法格式：{"outcome":"proposal","commands":[],"patches":[{"operation":"replace","blockId":"已有块 id","targetBlockIds":["已有块 id"],"after":"修改后的完整内容","reason":"修改原因"}],"finalAnswer":"已生成待确认的修改建议"}。',
      '合法 commands 包括 replace_text_by_regex、replace_block、insert_blocks、create_document；字段名和参数必须严格使用系统契约，不能改写为 type、value 或 update。',
    ].join('\n\n'),
    tools,
    output: Output.object({
      schema: agentOutputSchema,
      name: 'agent_patch_proposal',
      description: 'A validated proposal containing deterministic commands or document patches.',
    }),
    stopWhen: stepCountIs(AGENT_MAX_TOOL_ROUNDS),
    prepareStep: ({ stepNumber }) => {
      if (stepNumber >= AGENT_MAX_TOOL_ROUNDS - 1) return { toolChoice: 'none' as const }
      if (requiresKnowledgeRetrieval(input.prompt)) {
        const searchCall = calls.find(
          (call) => call.toolName === 'search_documents' && call.status === 'completed',
        )
        const readCall = calls.find(
          (call) => call.toolName === 'read_document' && call.status === 'completed',
        )
        if (!searchCall) {
          return { toolChoice: { type: 'tool' as const, toolName: 'search_documents' as const } }
        }
        if (!readCall && searchCall.resultJson !== '[]') {
          return { toolChoice: { type: 'tool' as const, toolName: 'read_document' as const } }
        }
      }
      return {}
    },
    maxOutputTokens: input.settings.maxTokens,
    temperature: input.settings.temperature,
    topP: input.settings.topP,
  })
  input.onProgress?.({ phase: 'planning', detail: '正在判断需要读取哪些资料' })
  let result
  try {
    result = await agent.generate({
      prompt: [input.prompt, input.context ? `\n当前上下文：\n${input.context}` : ''].join(''),
      abortSignal: input.signal,
      timeout: { totalMs: AGENT_MAX_TASK_DURATION_MS },
    })
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error
    const normalized = normalizeAgentOutputCandidate(error.text ?? '')
    if (normalized) {
      input.onProgress?.({ phase: 'finalizing', detail: '已校正修改格式' })
      return {
        output: JSON.stringify(normalizeAgentOutputForTaskIntent(normalized, input.prompt)),
        rounds: Math.max(1, calls.length),
        toolCalls: calls,
      }
    }
    input.onProgress?.({ phase: 'finalizing', detail: '正在校正修改格式' })
    const repaired = await repairAgentOutput(input, calls, error.text ?? '', error.message)
    return {
      output: JSON.stringify(normalizeAgentOutputForTaskIntent(repaired, input.prompt)),
      rounds: Math.max(1, calls.length + 1),
      toolCalls: calls,
    }
  }
  input.onProgress?.({ phase: 'finalizing', detail: '正在整理可确认的修改' })
  const parsedOutput = normalizeAgentOutputForTaskIntent(result.output, input.prompt)
  const output = JSON.stringify(parsedOutput)
  input.onDelta?.(result.reasoningText ?? '', 'reasoning')
  return { output, rounds: result.steps.length, toolCalls: calls }
}

async function repairAgentOutput(
  input: AgentRuntimeInput,
  calls: AgentToolCall[],
  invalidOutput: string,
  validationError: string,
): Promise<z.infer<typeof agentOutputSchema>> {
  const observations = calls
    .filter((call) => call.status === 'completed')
    .map((call) => `${call.toolName}: ${call.resultJson ?? 'null'}`)
    .join('\n')
    .slice(0, 24_000)
  try {
    const result = await generateText({
      model: createAiSdkModel(input.settings),
      system: [
        '你只负责把文档修改提案校正为合法 JSON，不调用工具，也不增加未经资料支持的事实。',
        '复杂改写可以使用 patches。commands 只允许 replace_text_by_regex、replace_block、insert_blocks、create_document，且字段名必须是 tool，不能是 type。',
        'commands 和 patches 二选一。patch 必须包含 operation、blockId、targetBlockIds、after、reason。所有 block id 必须来自上下文。',
        '有安全修改时 outcome 为 proposal；无需修改时为 no_change；缺少必要信息时为 blocked。后两者的 commands 和 patches 必须为空。',
        '不得声称内容已经写入、保存或执行完成。只输出 JSON。',
      ].join('\n'),
      prompt: [
        `用户任务：${input.prompt}`,
        input.context ? `允许的上下文：\n${input.context}` : '',
        observations ? `已取得的工具结果：\n${observations}` : '',
        `上一次无效输出：\n${invalidOutput.slice(0, 12_000)}`,
        `校验错误：${validationError}`,
        '请保留有效意图并修正结构。',
      ]
        .filter(Boolean)
        .join('\n\n'),
      output: Output.object({ schema: agentOutputSchema, name: 'agent_patch_repair' }),
      temperature: 0,
      maxOutputTokens: input.settings.maxTokens,
      abortSignal: input.signal,
      timeout: { totalMs: AGENT_MAX_TASK_DURATION_MS },
    })
    return result.output
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const normalized = normalizeAgentOutputCandidate(error.text ?? '')
      if (normalized) return normalized
    }
    throw error
  }
}

export function normalizeAgentOutputCandidate(
  value: string,
): z.infer<typeof agentOutputSchema> | null {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const candidate = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    if (Array.isArray(candidate.patches) && candidate.patches.length > 0) {
      candidate.commands = []
      candidate.patches = candidate.patches.map((patch) => {
        if (!patch || typeof patch !== 'object') return patch
        const fields = patch as Record<string, unknown>
        const blockId = typeof fields.blockId === 'string' ? fields.blockId : ''
        return {
          ...fields,
          operation: fields.operation === 'update' ? 'replace' : fields.operation,
          targetBlockIds:
            Array.isArray(fields.targetBlockIds) && fields.targetBlockIds.length > 0
              ? fields.targetBlockIds
              : blockId
                ? [blockId]
                : fields.targetBlockIds,
          after:
            typeof fields.after === 'string' && fields.after.length > 0
              ? fields.after
              : typeof fields.value === 'string'
                ? fields.value
                : fields.after,
        }
      })
    } else if (Array.isArray(candidate.commands)) {
      candidate.commands = candidate.commands.map((command) => {
        if (!command || typeof command !== 'object') return command
        const fields = command as Record<string, unknown>
        return fields.tool === undefined && fields.type === 'replace_text_by_regex'
          ? { ...fields, tool: fields.type }
          : fields
      })
    }
    const parsed = agentOutputSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function requiresKnowledgeRetrieval(prompt: string): boolean {
  return /(知识库|资料库|查找|搜索|检索|翻翻|找找|参考.*(?:资料|文档)|knowledge\s*base|search|look\s*up)/i.test(
    prompt,
  )
}

export function normalizeAgentOutputForTaskIntent(
  output: z.infer<typeof agentOutputSchema>,
  prompt: string,
): z.infer<typeof agentOutputSchema> {
  if (!requiresDocumentCreation(prompt)) return output
  if (output.commands.some((command) => command.tool === 'create_document')) return output
  if (output.patches.length === 0) return output

  const content = output.patches
    .map((patch) => patch.after.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!content) return output
  const requestedTitle = prompt.match(/《([^》]{1,160})》/)?.[1]?.trim()
  const contentTitle = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return agentOutputSchema.parse({
    outcome: 'proposal',
    commands: [
      {
        tool: 'create_document',
        title: requestedTitle || contentTitle || 'Agent 新建文档',
        content,
        reason: output.patches[0]?.reason || '根据用户要求创建新文档。',
      },
    ],
    patches: [],
    finalAnswer: output.finalAnswer,
  })
}

function requiresDocumentCreation(prompt: string): boolean {
  return /(?:新建|创建)[^。！？\n]{0,16}(?:一篇|页面|文档|子页面|笔记)/.test(prompt)
}

function getToolProgressLabel(name: string, completed: boolean): string {
  const labels: Record<string, [string, string]> = {
    get_current_document: ['正在读取当前页面', '已读取当前页面'],
    get_selected_blocks: ['正在确认选中的内容', '已确认选中的内容'],
    get_document_outline: ['正在查看页面结构', '已查看页面结构'],
    search_documents: ['正在知识库中查找资料', '已完成知识库检索'],
    read_document: ['正在阅读相关资料', '已读取相关资料'],
    find_blocks_by_regex: ['正在定位需要修改的内容', '已定位需要修改的内容'],
  }
  return labels[name]?.[completed ? 1 : 0] ?? (completed ? '工具调用已完成' : '正在调用工具')
}

export function parseAiSdkAgentOutput(value: string): z.infer<typeof agentOutputSchema> {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed
  try {
    return agentOutputSchema.parse(JSON.parse(candidate) as unknown)
  } catch (error) {
    throw new Error(
      `Agent 最终输出不符合 Patch schema：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function safeJson(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  return json.length > 24_000 ? `${json.slice(0, 24_000)}…` : json
}
