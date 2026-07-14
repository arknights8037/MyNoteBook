import { generateText, jsonSchema, ToolLoopAgent, stepCountIs, tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type { AgentToolCall } from '@/models/agentTool'
import { createAiSdkModel } from './AiSdkProvider'
import {
  createDefaultAgentExecutionPolicy,
  getAgentToolDefinition,
} from './AgentToolRegistry'
import type { AgentRuntimeInput, AgentRuntimeResult } from './AgentRuntime'
import { normalizeExecutionPolicy } from '@/models/executionPolicy'
import type { AiSettings } from '@/models/ai'
import { resolveProviderCapabilities } from '@/models/providerCapabilities'

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

const AGENT_TEXT_OUTPUT_PROTOCOL = [
  '最终响应使用普通文本输出一个 JSON 对象，不要使用 Markdown 围栏，也不要依赖 response_format 或 JSON Schema。',
  '对象字段固定为 outcome、commands、patches、finalAnswer。outcome 只能是 proposal、no_change、blocked。',
  'commands 和 patches 没有内容时必须输出空数组；finalAnswer 必须是面向用户的完整结论。',
].join('\n')

export async function runAiSdkAgent(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const policy = normalizeExecutionPolicy(
    input.executionPolicy ?? createDefaultAgentExecutionPolicy(input.settings.maxTokens),
  )
  const calls: AgentToolCall[] = []
  if (!resolveProviderCapabilities(input.settings.provider, input.settings.model).toolChoice) {
    input.onProgress?.({ phase: 'finalizing', detail: 'Capability Matrix 标记当前模型不支持工具调用，使用只读兼容模式' })
    return runToollessCompatibilityFallback(input, calls)
  }
  const callCounts = new Map<string, number>()
  const externalTools = new Map(
    (input.externalTools ?? []).map((definition) => [definition.runtimeName, definition]),
  )
  let failures = 0

  const execute = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const startedAt = Date.now()
    const callId = input.createId()
    input.onProgress?.({
      phase: 'tool_running',
      toolName: name,
      detail: getToolProgressLabel(name, false),
      toolCall: {
        id: callId,
        taskId: input.taskId,
        toolName: name,
        argumentsJson: JSON.stringify(args),
        resultJson: null,
        status: 'running',
        startedAt,
        completedAt: null,
        error: null,
      },
    })
    const definition = getAgentToolDefinition(name)
    const externalDefinition = externalTools.get(name)
    const nextCount = (callCounts.get(name) ?? 0) + 1
    callCounts.set(name, nextCount)
    let execution
    const policyAllowsTool =
      policy.allowedTools.includes(name) ||
      (name.startsWith('mcp__') && policy.allowedTools.includes('mcp:*'))
    if (!policyAllowsTool) {
      execution = { ok: false, error: `ExecutionPolicy 不允许工具 ${name}。` }
    } else if (name === 'request_authorizer_input' && !policy.allowUserInput) {
      execution = { ok: false, error: 'ExecutionPolicy 不允许请求用户输入。' }
    } else if ((!definition && !externalDefinition) || definition?.risk === 'write') {
      execution = { ok: false, error: `工具 ${name} 不允许在 Agent loop 中执行。` }
    } else if (
      nextCount > (definition?.maxCallsPerTask ?? externalDefinition?.maxCallsPerTask ?? 0)
    ) {
      execution = { ok: false, error: `工具 ${name} 超过单任务调用上限。` }
    } else {
      execution = await input.executeTool({ name, arguments: args })
    }
    const call: AgentToolCall = {
      id: callId,
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
    input.onProgress?.({
      phase: 'tool_completed',
      toolName: name,
      detail: execution.ok ? getToolProgressLabel(name, true) : getToolFailureProgressLabel(name),
      toolCall: call,
    })
    await input.recordToolCall(call)
    if (!execution.ok) {
      failures += 1
      if (failures > policy.maxToolFailures) throw new Error('Agent 工具失败次数超过上限。')
      return { ok: false, error: execution.error }
    }
    return execution.value
  }

  const tools: ToolSet = {
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
    read_skill_file: tool({
      description:
        '读取用户已启用技能目录中的 UTF-8 文本文件。只接受已启用技能 ID 和该技能文件树中的相对路径。',
      inputSchema: z.object({
        skillId: z.string().min(1).max(80),
        relativePath: z.string().min(1).max(500),
      }),
      execute: (args) => execute('read_skill_file', args),
    }),
    request_authorizer_input: tool({
      description:
        '当关键目标、范围、结构或写入位置需要授权人决策时，暂停任务并等待授权人回答。不要询问可从上下文或只读工具自行确定的事实。',
      inputSchema: z.object({
        question: z.string().min(1).max(500),
        context: z.string().max(1_000).optional(),
        options: z.array(z.string().min(1).max(160)).min(2).max(5).optional(),
        allowFreeText: z.boolean().optional(),
      }),
      execute: (args) => execute('request_authorizer_input', args),
    }),
    execute_shell: tool({
      description:
        '执行受限的只读 Windows 命令。command 仅可为 Get-Process、Get-Service、Get-Command、Get-Date、git、rg、where.exe、node、pnpm、npm、python、cargo、rustc；args 仍受本机白名单校验。',
      inputSchema: z.object({
        command: z.enum([
          'Get-Process',
          'Get-Service',
          'Get-Command',
          'Get-Date',
          'git',
          'rg',
          'where.exe',
          'node',
          'pnpm',
          'npm',
          'python',
          'cargo',
          'rustc',
        ]),
        args: z.array(z.string().max(500)).max(12).optional(),
        timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
        maxOutputChars: z.number().int().min(4_096).max(65_536).optional(),
      }),
      execute: (args) => execute('execute_shell', args),
    }),
    inspect_environment_paths: tool({
      description:
        '读取当前进程可见的 PATH、PATHEXT、PSModulePath，返回拆分后的路径和存在性；不会读取其他环境变量。',
      inputSchema: z.object({}),
      execute: (args) => execute('inspect_environment_paths', args),
    }),
    discover_local_tools: tool({
      description:
        '扫描 PATH 并发现本机工具，不执行工具。names 为空时检查常见开发工具；也可提供最多 32 个安全工具名。',
      inputSchema: z.object({ names: z.array(z.string().min(1).max(80)).max(32).optional() }),
      execute: (args) => execute('discover_local_tools', args),
    }),
    get_system_info: tool({
      description: '读取操作系统、CPU 架构、逻辑 CPU 数和应用当前工作目录，不读取用户密钥。',
      inputSchema: z.object({}),
      execute: (args) => execute('get_system_info', args),
    }),
    create_automation_draft: tool({
      description:
        '用户明确要求创建自动化时使用。工具会先请求用户确认，然后只创建停用草稿，不会运行或排期。创建成功后最终结果使用 no_change，并说明可前往自动化任务页审阅启用。',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        instruction: z.string().min(1).max(8_000),
        triggerType: z.enum(['manual', 'interval', 'daily']),
        intervalMinutes: z.number().int().min(5).max(10_080).optional(),
        dailyTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
        bindCurrentDocument: z.boolean().optional(),
      }),
      execute: (args) => execute('create_automation_draft', args),
    }),
    create_skill_draft: tool({
      description:
        '用户明确要求创建可复用 Skill 时使用。工具会先请求用户确认，然后写入停用草稿；instructions 应包含完整触发条件、步骤和边界。创建成功后最终结果使用 no_change，并提示到插件技能页审阅启用。',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(500),
        instructions: z.string().min(1).max(24_000),
      }),
      execute: (args) => execute('create_skill_draft', args),
    }),
  }

  for (const definition of externalTools.values()) {
    tools[definition.runtimeName] = tool({
      description: [
        `来自外部 MCP 服务“${definition.serverName}”的工具。`,
        definition.description,
        definition.requiresConfirmation
          ? '该工具调用前需要授权人确认。'
          : '服务将该工具标记为只读。',
      ]
        .filter(Boolean)
        .join(' '),
      inputSchema: jsonSchema(definition.inputSchema),
      execute: (args) => execute(definition.runtimeName, args as Record<string, unknown>),
    })
  }

  const agent = new ToolLoopAgent({
    model: createAiSdkModel(input.settings),
    instructions: [
      input.systemPrompt,
      input.intent === 'create'
        ? '本次任务要求创建独立页面或文档。最终提案应使用 create_document；如果先生成 patches，运行时会将其归并为单个创建提案。'
        : '',
      AGENT_TEXT_OUTPUT_PROTOCOL,
      '复杂改写的唯一合法格式：{"outcome":"proposal","commands":[],"patches":[{"operation":"replace","blockId":"已有块 id","targetBlockIds":["已有块 id"],"after":"修改后的完整内容","reason":"修改原因"}],"finalAnswer":"已生成待确认的修改建议"}。',
      '合法 commands 包括 replace_text_by_regex、replace_block、insert_blocks、create_document；字段名和参数必须严格使用系统契约，不能改写为 type、value 或 update。',
    ].join('\n\n'),
    tools,
    stopWhen: stepCountIs(policy.maxToolRounds),
    prepareStep: ({ stepNumber }) => {
      if (stepNumber >= policy.maxToolRounds - 1) return { toolChoice: 'none' as const }
      if (
        input.intent === 'interactive' &&
        !calls.some((call) => call.toolName === 'request_authorizer_input')
      ) {
        return {
          toolChoice: { type: 'tool' as const, toolName: 'request_authorizer_input' as const },
        }
      }
      if (input.intent === 'research' || requiresKnowledgeRetrieval(input.prompt)) {
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
    maxOutputTokens: Math.min(input.settings.maxTokens, policy.tokenBudget),
    ...samplingParameters(input.settings),
  })
  input.onProgress?.({ phase: 'planning', detail: '正在判断需要读取哪些资料' })
  let result
  try {
    result = await agent.generate({
      prompt: [input.prompt, input.context ? `\n当前上下文：\n${input.context}` : ''].join(''),
      abortSignal: input.signal,
      timeout: { totalMs: policy.maxDurationMs },
    })
  } catch (error) {
    if (!isToolCompatibilityError(error)) throw error
    input.onProgress?.({ phase: 'finalizing', detail: '当前模型不支持工具调用，正在切换兼容模式' })
    return runToollessCompatibilityFallback(input, calls)
  }

  const reasoningText = collectReasoningText(result)
  if (reasoningText) input.onDelta?.(reasoningText, 'reasoning')
  input.onProgress?.({ phase: 'finalizing', detail: '正在整理可确认的修改' })
  let parsedOutput = normalizeAgentOutputCandidate(result.text)
  if (!parsedOutput) {
    input.onProgress?.({ phase: 'finalizing', detail: '正在兼容当前模型的输出格式' })
    parsedOutput = await repairAgentOutput(
      input,
      calls,
      result.text,
      '模型返回内容不是可识别的 Agent JSON。',
    )
  }
  parsedOutput = normalizeAgentOutputForTaskIntent(parsedOutput, input.prompt, input.intent)
  if (!policy.allowWriteProposals && parsedOutput.outcome === 'proposal') {
    parsedOutput = agentOutputSchema.parse({
      outcome: 'blocked',
      commands: [],
      patches: [],
      finalAnswer: '当前 ExecutionPolicy 不允许提出写入修改。',
    })
  }
  const output = JSON.stringify(parsedOutput)
  return { output, rounds: result.steps.length, toolCalls: calls }
}

async function repairAgentOutput(
  input: AgentRuntimeInput,
  calls: AgentToolCall[],
  invalidOutput: string,
  validationError: string,
): Promise<z.infer<typeof agentOutputSchema>> {
  const policy = normalizeExecutionPolicy(
    input.executionPolicy ?? createDefaultAgentExecutionPolicy(input.settings.maxTokens),
  )
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
        AGENT_TEXT_OUTPUT_PROTOCOL,
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
      ...samplingParameters(input.settings, 0),
      maxOutputTokens: Math.min(input.settings.maxTokens, policy.tokenBudget),
      abortSignal: input.signal,
      timeout: { totalMs: policy.maxDurationMs },
    })
    const normalized = normalizeAgentOutputCandidate(result.text)
    return normalized ?? createCompatibleAgentTextOutput(result.text || invalidOutput, input.intent)
  } catch (error) {
    if (invalidOutput.trim()) return createCompatibleAgentTextOutput(invalidOutput, input.intent)
    throw error
  }
}

async function runToollessCompatibilityFallback(
  input: AgentRuntimeInput,
  calls: AgentToolCall[],
): Promise<AgentRuntimeResult> {
  const policy = normalizeExecutionPolicy(
    input.executionPolicy ?? createDefaultAgentExecutionPolicy(input.settings.maxTokens),
  )
  const result = await generateText({
    model: createAiSdkModel(input.settings),
    system: [
      input.systemPrompt,
      AGENT_TEXT_OUTPUT_PROTOCOL,
      '当前模型不支持工具调用。仅依据已提供的上下文回答；缺少必要资料时将 outcome 设为 blocked。',
    ].join('\n\n'),
    prompt: [input.prompt, input.context ? `当前上下文：\n${input.context}` : '']
      .filter(Boolean)
      .join('\n\n'),
    ...samplingParameters(input.settings),
    maxOutputTokens: Math.min(input.settings.maxTokens, policy.tokenBudget),
    abortSignal: input.signal,
    timeout: { totalMs: policy.maxDurationMs },
  })
  if (result.reasoningText) input.onDelta?.(result.reasoningText, 'reasoning')
  const parsed =
    normalizeAgentOutputCandidate(result.text) ??
    createCompatibleAgentTextOutput(result.text, input.intent)
  return {
    output: JSON.stringify(normalizeAgentOutputForTaskIntent(parsed, input.prompt, input.intent)),
    rounds: 1,
    toolCalls: calls,
  }
}

function samplingParameters(settings: AiSettings, temperature = settings.temperature) {
  const capabilities = resolveProviderCapabilities(settings.provider, settings.model)
  return {
    ...(capabilities.temperature ? { temperature } : {}),
    ...(capabilities.topP ? { topP: settings.topP } : {}),
  }
}

function collectReasoningText(result: {
  reasoningText?: string
  steps: Array<{ reasoningText?: string }>
}): string {
  const stepReasoning = result.steps
    .map((step) => step.reasoningText?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
  return stepReasoning || result.reasoningText?.trim() || ''
}

function isToolCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:tool|function|工具|函数).*(?:unsupported|not supported|not available|不支持|无效)|(?:unsupported|not supported|不支持).*(?:tool|function|工具|函数)/i.test(
    message,
  )
}

export function createCompatibleAgentTextOutput(
  value: string,
  intent: AgentRuntimeInput['intent'] = 'default',
): z.infer<typeof agentOutputSchema> {
  const finalAnswer =
    value
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .slice(0, 24_000) || '当前模型没有返回可显示的文本。'
  return agentOutputSchema.parse({
    outcome: intent === 'plan' || intent === 'research' ? 'no_change' : 'blocked',
    commands: [],
    patches: [],
    finalAnswer,
  })
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
    const parsedJson = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    const nestedOutput = [parsedJson.result, parsedJson.output, parsedJson.response].find(isRecord)
    const candidate = nestedOutput ? { ...nestedOutput } : { ...parsedJson }
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
    if (Array.isArray(candidate.patches) && candidate.patches.length > 0) {
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
    } else if (Array.isArray(candidate.commands)) {
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
  intent: AgentRuntimeInput['intent'] = 'default',
): z.infer<typeof agentOutputSchema> {
  if (intent === 'plan' || intent === 'research') {
    return agentOutputSchema.parse({
      outcome: 'no_change',
      commands: [],
      patches: [],
      finalAnswer: output.finalAnswer,
    })
  }
  if (intent !== 'create' && !requiresDocumentCreation(prompt)) return output
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
    read_skill_file: ['正在读取技能资料', '已读取技能资料'],
    request_authorizer_input: ['正在等待授权人决策', '已收到授权人回答'],
    execute_shell: ['正在执行受限本机命令', '受限本机命令已完成'],
    inspect_environment_paths: ['正在检查环境路径', '已检查环境路径'],
    discover_local_tools: ['正在发现本机工具', '已发现本机工具'],
    get_system_info: ['正在读取系统信息', '已读取系统信息'],
    create_automation_draft: ['正在确认自动化草稿', '已创建自动化草稿'],
    create_skill_draft: ['正在确认 Skill 草稿', '已创建 Skill 草稿'],
  }
  return labels[name]?.[completed ? 1 : 0] ?? (completed ? '工具调用已完成' : '正在调用工具')
}

function getToolFailureProgressLabel(name: string): string {
  return `${getToolProgressLabel(name, false).replace(/^正在/, '')}失败`
}

export function parseAiSdkAgentOutput(value: string): z.infer<typeof agentOutputSchema> {
  const normalized = normalizeAgentOutputCandidate(value)
  if (normalized) return normalized
  throw new Error('Agent 最终输出不符合 Patch schema。')
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

function safeJson(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  return json.length > 24_000 ? `${json.slice(0, 24_000)}…` : json
}
