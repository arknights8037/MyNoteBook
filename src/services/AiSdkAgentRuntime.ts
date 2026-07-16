import { jsonSchema, ToolLoopAgent, stepCountIs, tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type { AgentToolCall } from '@/models/agentTool'
import type { AgentTimelineEvent } from '@/models/agentRuntime'
import { createAiSdkModel } from './AiSdkProvider'
import {
  createDefaultAgentExecutionPolicy,
  AGENT_TOOL_REGISTRY,
  getAgentToolDefinition,
  resolveAgentOutputTokenLimit,
} from './AgentToolRegistry'
import type { AgentRuntimeInput, AgentRuntimeResult } from './AgentRuntime'
import { normalizeExecutionPolicy } from '@/models/executionPolicy'
import type { AiSettings } from '@/models/ai'
import { resolveProviderCapabilities } from '@/models/providerCapabilities'
import { throwIfAgentToolAborted } from './AgentToolCancellation'
import type { AgentToolExecutionResult } from './AgentToolExecutor'
import { redactSensitiveText, redactSensitiveValue, safeAuditJson } from './SensitiveDataRedaction'
import { validateAgentOutputContract } from './AgentOutputContract'

const regexCommandSchema = z.object({
  tool: z.literal('replace_text_by_regex'),
  pattern: z.string(),
  replacement: z.string(),
  flags: z.string().optional(),
  blockIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
})

const replaceBlockCommandSchema = z.object({
  tool: z.literal('replace_block'),
  documentId: z.string().min(1).optional(),
  blockId: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
})

const insertBlocksCommandSchema = z.object({
  tool: z.literal('insert_blocks'),
  documentId: z.string().min(1).optional(),
  anchorBlockId: z.string().min(1),
  position: z.enum(['before', 'after', 'append']),
  content: z.string().min(1),
  reason: z.string().optional(),
})

const createDocumentCommandSchema = z.object({
  tool: z.literal('create_document'),
  title: z.string().min(1),
  content: z.string().min(1),
  parentDocumentId: z.string().nullable().optional(),
  reason: z.string().optional(),
})

const createGroupCommandSchema = z.object({
  tool: z.literal('create_group'),
  title: z.string().min(1),
  initialDocument: z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
    })
    .optional(),
  reason: z.string().optional(),
})

const commandSchema = z.discriminatedUnion('tool', [
  regexCommandSchema,
  replaceBlockCommandSchema,
  insertBlocksCommandSchema,
  createDocumentCommandSchema,
  createGroupCommandSchema,
])

const patchSchema = z
  .object({
    documentId: z.string().trim().min(1),
    operation: z.enum(['replace', 'insert_before', 'insert_after', 'append']),
    blockId: z.string().trim().min(1),
    targetBlockIds: z.array(z.string().trim().min(1)).min(1),
    after: z.string().min(1),
    reason: z.string().trim().min(1),
  })
  .superRefine((patch, context) => {
    if (new Set(patch.targetBlockIds).size !== patch.targetBlockIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['targetBlockIds'],
        message: '单个 Patch 的 targetBlockIds 不能包含重复块。',
      })
    }
    if (!patch.targetBlockIds.includes(patch.blockId)) {
      context.addIssue({
        code: 'custom',
        path: ['blockId'],
        message: 'Patch 的 blockId 必须包含在 targetBlockIds 中。',
      })
    }
    if (patch.operation !== 'replace' && patch.targetBlockIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['targetBlockIds'],
        message: '插入 Patch 只能使用一个稳定锚点块。',
      })
    }
  })

const patchBatchSchema = z
  .array(patchSchema)
  .max(50)
  .superRefine((patches, context) => {
    const targets = new Set<string>()
    for (const [patchIndex, patch] of patches.entries()) {
      for (const blockId of patch.targetBlockIds) {
        const key = `${patch.documentId}:${blockId}`
        if (targets.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [patchIndex, 'targetBlockIds'],
            message:
              '同一批 Patch 不能重复修改同一个目标块；请把该块的替换与补充合并成一个 replace Patch。',
          })
        }
        targets.add(key)
      }
    }
  })

const documentEditSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    targetBlockIds: z.array(z.string().trim().min(1)).min(1),
    content: z.string().min(1),
    reason: z.string().trim().min(1),
  }),
  z.object({
    kind: z.enum(['insert_before', 'insert_after', 'append']),
    anchorBlockId: z.string().trim().min(1),
    content: z.string().min(1),
    reason: z.string().trim().min(1),
  }),
])

const documentEditGroupSchema = z
  .object({
    documentId: z.string().trim().min(1),
    edits: z.array(documentEditSchema).min(1).max(50),
  })
  .superRefine((group, context) => {
    const targets = new Set<string>()
    for (const [editIndex, edit] of group.edits.entries()) {
      const blockIds = edit.kind === 'replace' ? edit.targetBlockIds : [edit.anchorBlockId]
      if (new Set(blockIds).size !== blockIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['edits', editIndex],
          message: '单个 replace edit 不能重复声明同一个目标块。',
        })
      }
      for (const blockId of blockIds) {
        if (targets.has(blockId)) {
          context.addIssue({
            code: 'custom',
            path: ['edits', editIndex],
            message: '同一文档内的 edits 不能重复修改或锚定同一个块；请合并成一个 replace edit。',
          })
        }
        targets.add(blockId)
      }
    }
  })

const documentEditProposalSchema = z
  .object({
    documents: z.array(documentEditGroupSchema).min(1).max(20),
    summary: z.string().trim().min(1),
  })
  .superRefine((proposal, context) => {
    const documentIds = proposal.documents.map((document) => document.documentId)
    if (new Set(documentIds).size !== documentIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: '同一文档只能在 documents 中出现一次；请合并该文档的 edits。',
      })
    }
  })

type AgentCommand = z.infer<typeof commandSchema>
type AgentPatch = z.infer<typeof patchSchema>

function assertDisjointCommandTargets(commands: AgentCommand[]): void {
  const blockCommands = commands.filter(
    (
      command,
    ): command is
      | z.infer<typeof replaceBlockCommandSchema>
      | z.infer<typeof insertBlocksCommandSchema> =>
      command.tool === 'replace_block' || command.tool === 'insert_blocks',
  )
  const regexCommands = commands.filter((command) => command.tool === 'replace_text_by_regex')
  if (regexCommands.length > 1 || (regexCommands.length > 0 && blockCommands.length > 0)) {
    throw new Error(
      '正则替换不能与其他块修改混在同一批提案中；请改为一批 targetBlockIds 互不重叠的 Patch。',
    )
  }

  const targets = new Set<string>()
  for (const command of blockCommands) {
    const blockId = command.tool === 'replace_block' ? command.blockId : command.anchorBlockId
    const key = `${command.documentId ?? '__current__'}:${blockId}`
    if (targets.has(key)) {
      throw new Error(
        '多个写命令不能修改或锚定同一个目标块；请合并为一个 replace_block，或提交一个合并后的复杂 Patch。',
      )
    }
    targets.add(key)
  }
}

const agentOutputSchema = z
  .object({
    outcome: z.enum(['proposal', 'no_change', 'blocked']).default('proposal'),
    commands: z.array(commandSchema).default([]),
    patches: patchBatchSchema.default([]),
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

export async function runAiSdkAgent(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const policy = normalizeExecutionPolicy(
    input.executionPolicy ?? createDefaultAgentExecutionPolicy(input.settings.maxTokens),
  )
  const calls: AgentToolCall[] = []
  if (!resolveProviderCapabilities(input.settings.provider, input.settings.model).toolChoice) {
    throw new Error('当前模型不支持 Agent 工具调用，请选择支持原生工具调用的模型。')
  }
  const callCounts = new Map<string, number>()
  const externalTools = new Map(
    (input.externalTools ?? []).map((definition) => [definition.runtimeName, definition]),
  )
  const proposedCommands: AgentCommand[] = []
  const proposedPatches: AgentPatch[] = []
  const inFlightTools = new Set<Promise<unknown>>()
  const failedCallSignatures = new Set<string>()
  const stepStartedAt = new Map<number, number>()
  let failures = 0

  const executeTracked = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    throwIfAgentToolAborted(input.signal)
    const startedAt = Date.now()
    const callId = input.createId()
    const runningCall: AgentToolCall = {
      id: callId,
      taskId: input.taskId,
      toolName: name,
      argumentsJson: safeAuditJson(args),
      resultJson: null,
      status: 'running',
      startedAt,
      completedAt: null,
      error: null,
    }
    input.onProgress?.({
      phase: 'tool_running',
      toolName: name,
      detail: getToolProgressLabel(name, false),
      toolCall: runningCall,
      timelineEvent: createToolTimelineEvent(runningCall, getToolProgressLabel(name, false)),
    })
    await input.recordToolCall(runningCall)
    throwIfAgentToolAborted(input.signal)
    const definition = getAgentToolDefinition(name)
    const externalDefinition = externalTools.get(name)
    const nextCount = (callCounts.get(name) ?? 0) + 1
    callCounts.set(name, nextCount)
    let execution: AgentToolExecutionResult = { ok: false, error: '工具未执行。' }
    let executionWasAborted = false
    const policyAllowsTool =
      policy.allowedTools.includes(name) ||
      (name.startsWith('mcp__') && policy.allowedTools.includes('mcp:*'))
    const signature = createToolCallSignature(name, args)
    if (failedCallSignatures.has(signature)) {
      execution = { ok: false, error: `工具 ${name} 的相同参数已经失败；请调整参数或停止。` }
    } else if (!policyAllowsTool) {
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
      try {
        const maxReadRetries =
          definition?.risk === 'read' || externalDefinition?.readOnly
            ? Math.min(policy.maxRetries, 2)
            : 0
        let attempt = 0
        while (attempt <= maxReadRetries) {
          execution = await input.executeTool({
            callId,
            name,
            arguments: args,
            signal: input.signal,
          })
          if (execution.ok || !execution.retryable || attempt >= maxReadRetries) break
          attempt += 1
          const retryDelayMs = Math.min(
            Math.max(execution.retryAfterMs ?? 250 * 2 ** (attempt - 1), 0),
            5_000,
          )
          input.onProgress?.({
            phase: 'planning',
            toolName: name,
            detail: `${getToolProgressLabel(name, false)}失败，${retryDelayMs}ms 后自动重试（${attempt}/${maxReadRetries}）`,
            timelineEvent: {
              id: `retry:${callId}:${attempt}`,
              kind: 'retry',
              status: 'running',
              detail: `${name}：${execution.errorCode ?? execution.error ?? '瞬态错误'}，${retryDelayMs}ms 后重试`,
              occurredAt: Date.now(),
              completedAt: null,
              toolCallId: callId,
            },
          })
          await waitForRetry(retryDelayMs, input.signal)
          input.onProgress?.({
            phase: 'tool_running',
            toolName: name,
            detail: `${getToolProgressLabel(name, false)}（重试 ${attempt}/${maxReadRetries}）`,
            timelineEvent: {
              id: `retry:${callId}:${attempt}`,
              kind: 'retry',
              status: 'completed',
              detail: `开始第 ${attempt} 次自动重试`,
              occurredAt: Date.now(),
              completedAt: Date.now(),
              toolCallId: callId,
            },
          })
        }
      } catch (error) {
        executionWasAborted = input.signal?.aborted === true || isAbortError(error)
        execution = {
          ok: false,
          error: executionWasAborted
            ? 'Agent 工具调用已取消。'
            : error instanceof Error
              ? error.message
              : String(error),
        }
      }
    }
    const safeValue = execution.ok ? redactSensitiveValue(execution.value) : undefined
    const safeExecutionError = execution.error ? redactSensitiveText(execution.error) : null
    const call: AgentToolCall = {
      id: callId,
      taskId: input.taskId,
      toolName: name,
      argumentsJson: safeAuditJson(args),
      resultJson: execution.ok ? safeAuditJson(safeValue) : null,
      status: execution.ok ? 'completed' : 'failed',
      startedAt,
      completedAt: Date.now(),
      error: safeExecutionError,
    }
    calls.push(call)
    input.onProgress?.({
      phase: 'tool_completed',
      toolName: name,
      detail: execution.ok ? getToolProgressLabel(name, true) : getToolFailureProgressLabel(name),
      toolCall: call,
      timelineEvent: createToolTimelineEvent(
        call,
        execution.ok ? getToolProgressLabel(name, true) : getToolFailureProgressLabel(name),
      ),
    })
    await input.recordToolCall(call)
    if (input.signal?.aborted) throwIfAgentToolAborted(input.signal)
    if (executionWasAborted) {
      throw Object.assign(new Error('Agent 工具调用已取消。'), { name: 'AbortError' })
    }
    if (!execution.ok) {
      failedCallSignatures.add(signature)
      failures += 1
      if (failures >= policy.maxToolFailures) throw new Error('Agent 工具失败次数达到上限。')
      return { ok: false, error: safeExecutionError }
    }
    return safeValue
  }

  const execute = (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const lifecycle = executeTracked(name, args)
    inFlightTools.add(lifecycle)
    void lifecycle.finally(() => inFlightTools.delete(lifecycle)).catch(() => undefined)
    return lifecycle
  }

  const captureProposal = async (
    name: string,
    args: Record<string, unknown>,
    capture: () => void,
  ): Promise<unknown> => {
    const startedAt = Date.now()
    const callId = input.createId()
    const runningCall: AgentToolCall = {
      id: callId,
      taskId: input.taskId,
      toolName: name,
      argumentsJson: safeAuditJson(args),
      resultJson: null,
      status: 'running',
      startedAt,
      completedAt: null,
      error: null,
    }
    input.onProgress?.({
      phase: 'tool_running',
      toolName: name,
      detail: getToolProgressLabel(name, false),
      toolCall: runningCall,
      timelineEvent: createToolTimelineEvent(runningCall, getToolProgressLabel(name, false)),
    })
    await input.recordToolCall(runningCall)
    throwIfAgentToolAborted(input.signal)
    const definition = getAgentToolDefinition(name)
    const signature = createToolCallSignature(name, args)
    const nextCount = (callCounts.get(name) ?? 0) + 1
    callCounts.set(name, nextCount)
    let error: string | null = null
    if (failedCallSignatures.has(signature)) {
      error = `工具 ${name} 的相同参数已经失败；请根据错误重新规划完整提案。`
    } else if (!policy.allowWriteProposals) {
      error = 'ExecutionPolicy 不允许提出写入修改。'
    } else if (!policy.allowedTools.includes(name)) {
      error = `ExecutionPolicy 不允许工具 ${name}。`
    } else if (!definition || definition.risk !== 'write') {
      error = `工具 ${name} 不是已注册的写入提案工具。`
    } else if (nextCount > definition.maxCallsPerTask) {
      error = `工具 ${name} 超过单任务调用上限。`
    } else {
      try {
        capture()
      } catch (captureError) {
        error = captureError instanceof Error ? captureError.message : String(captureError)
      }
    }
    const value = error
      ? null
      : { proposalCaptured: true, requiresConfirmation: true, message: '提案已进入确认队列。' }
    const call: AgentToolCall = {
      id: callId,
      taskId: input.taskId,
      toolName: name,
      argumentsJson: safeAuditJson(args),
      resultJson: value ? safeAuditJson(value) : null,
      status: error ? 'failed' : 'completed',
      startedAt,
      completedAt: Date.now(),
      error,
    }
    calls.push(call)
    input.onProgress?.({
      phase: 'tool_completed',
      toolName: name,
      detail: error ? getToolFailureProgressLabel(name) : getToolProgressLabel(name, true),
      toolCall: call,
      timelineEvent: createToolTimelineEvent(
        call,
        error ? getToolFailureProgressLabel(name) : getToolProgressLabel(name, true),
      ),
    })
    await input.recordToolCall(call)
    if (error) {
      failedCallSignatures.add(signature)
      failures += 1
      if (failures >= policy.maxToolFailures) throw new Error('Agent 工具失败次数达到上限。')
      return { ok: false, error }
    }
    return value
  }

  const captureCommand = async (command: AgentCommand): Promise<unknown> =>
    captureProposal(command.tool, command, () => {
      if (proposedPatches.length > 0) throw new Error('commands 和 patches 不能混合提交。')
      const candidate = [...proposedCommands, command]
      assertDisjointCommandTargets(candidate)
      const validated = agentOutputSchema.safeParse({
        outcome: 'proposal',
        commands: candidate,
        patches: [],
        finalAnswer: '',
      })
      if (!validated.success) throw new Error(validated.error.issues[0]?.message ?? '提案无效。')
      proposedCommands.push(command)
    })

  const captureDocumentEdits = async (
    args: z.infer<typeof documentEditProposalSchema>,
  ): Promise<unknown> =>
    captureProposal('submit_document_edits', args, () => {
      if (proposedCommands.length > 0 || proposedPatches.length > 0) {
        throw new Error('一个任务只能提交一批最终写入提案。')
      }
      const proposal = documentEditProposalSchema.parse(args)
      input.validateDocumentEditProposal?.(proposal)
      const patches = proposal.documents.flatMap((document) =>
        document.edits.map((edit) => ({
          documentId: document.documentId,
          operation: edit.kind,
          blockId: edit.kind === 'replace' ? (edit.targetBlockIds[0] ?? '') : edit.anchorBlockId,
          targetBlockIds: edit.kind === 'replace' ? edit.targetBlockIds : [edit.anchorBlockId],
          after: edit.content,
          reason: edit.reason,
        })),
      )
      proposedPatches.push(...patches)
    })

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
      description:
        '搜索本地知识库。默认 scope=workspace，只检索当前项目配置的文档分组；当工作区证据不足时可主动改用 scope=global 扩大到全库，并在过程里说明扩大原因。',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
        scope: z.enum(['workspace', 'global']).optional(),
      }),
      execute: (args) => execute('search_documents', args),
    }),
    list_document_groups: tool({
      description:
        '列出或按名称筛选知识库分组，返回真实 group id、标题和子项数量。需要把文档创建到指定分组时先调用本工具，不要猜测父级字段或 ID。',
      inputSchema: z.object({ query: z.string().max(160).optional() }),
      execute: (args) => execute('list_document_groups', args),
    }),
    read_document: tool({
      description:
        '按文档 ID 分页读取知识库块，返回 revision、canonical Markdown 和稳定 block id。结果截断时使用 nextCursor 继续；已知目标块时优先传 blockIds。',
      inputSchema: z.object({
        documentId: z.string().min(1),
        cursor: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(4_096).max(65_536).optional(),
        blockIds: z.array(z.string().min(1)).max(100).optional(),
      }),
      execute: (args) => execute('read_document', args),
    }),
    list_mind_maps: tool({
      description: '列出本地思维导图的 ID、标题、节点数和当前版本。',
      inputSchema: z.object({}),
      execute: (args) => execute('list_mind_maps', args),
    }),
    read_mind_map: tool({
      description:
        '读取一张思维导图或指定节点下的子树。先通过 list_mind_maps 获取真实 mindMapId；大图应限制 depth/maxNodes 并继续按 nodeId 查询。',
      inputSchema: z.object({
        mindMapId: z.string().min(1),
        nodeId: z.string().min(1).optional(),
        depth: z.number().int().min(0).max(32).optional(),
        maxNodes: z.number().int().min(1).max(1_000).optional(),
        includeNotes: z.boolean().optional(),
        includeSources: z.boolean().optional(),
      }),
      execute: (args) => execute('read_mind_map', args),
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
    replace_text_by_regex: tool({
      description:
        '提交一个正则文本替换提案，进入用户确认队列；不会立即写入。仅在已经读取并确认目标范围后调用。',
      inputSchema: regexCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand({ tool: 'replace_text_by_regex', ...args }),
    }),
    replace_block: tool({
      description:
        '提交一个完整块替换提案，进入用户确认队列；不会立即写入。blockId 必须来自本次读取结果。',
      inputSchema: replaceBlockCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand({ tool: 'replace_block', ...args }),
    }),
    insert_blocks: tool({
      description:
        '提交一个块插入提案，进入用户确认队列；不会立即写入。anchorBlockId 必须来自本次读取结果。',
      inputSchema: insertBlocksCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand({ tool: 'insert_blocks', ...args }),
    }),
    create_document: tool({
      description:
        '提交一篇完整新文档的待确认提案，不会立即写入。若要指定父级，只能使用已经通过工具读取到的真实 parentDocumentId；未知时先读取或询问，不得猜测字段。',
      inputSchema: createDocumentCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand({ tool: 'create_document', ...args }),
    }),
    create_group: tool({
      description:
        '提交新分组提案，可通过 initialDocument 同时提交首篇完整文档；进入用户确认队列，不会立即写入。',
      inputSchema: createGroupCommandSchema.omit({ tool: true }),
      execute: (args) => captureCommand({ tool: 'create_group', ...args }),
    }),
    submit_document_edits: tool({
      description:
        '提交一个或多个文档的待确认修改，不会立即写入。每个文档只声明一次 documentId；replace 使用 targetBlockIds，插入使用 anchorBlockId。同一文档内一个块只能属于一个 edit，同一块的替换与补充必须合并成一个 replace edit。',
      inputSchema: documentEditProposalSchema,
      execute: captureDocumentEdits,
    }),
  }

  for (const definition of AGENT_TOOL_REGISTRY) {
    const runtimeTool = tools[definition.name]
    if (runtimeTool)
      tools[definition.name] = { ...runtimeTool, description: definition.description }
  }

  for (const definition of externalTools.values()) {
    tools[definition.runtimeName] = tool({
      description: [
        `来自外部 MCP 服务“${definition.serverName}”的工具。`,
        definition.description,
        definition.requiresConfirmation
          ? '该工具调用前需要授权人确认。'
          : definition.serverTrusted
            ? '该服务已被授权人标记为可信，调用由 Runtime 自动批准。'
            : '该工具可在当前策略下直接调用。',
      ]
        .filter(Boolean)
        .join(' '),
      inputSchema: jsonSchema(definition.inputSchema),
      execute: (args) => execute(definition.runtimeName, args as Record<string, unknown>),
    })
  }

  const activeToolNames = Object.keys(tools).filter((name) => policyAllowsToolName(name, policy))
  const activeToolSet = Object.fromEntries(
    activeToolNames.map((name) => [name, tools[name]]),
  ) as ToolSet
  const agent = new ToolLoopAgent({
    model: createAiSdkModel(input.settings),
    instructions: [
      input.systemPrompt,
      `本次 Runtime 实际可用工具：${activeToolNames.length > 0 ? activeToolNames.join('、') : '无'}。未列出的工具不可调用。`,
      !input.outputContract && input.intent === 'create'
        ? '本次任务要求创建独立页面或文档。请在完成必要判断后主动调用 create_document 提案工具。'
        : '',
      input.outputContract
        ? ''
        : '写入建议通过 Runtime 暴露的原生提案工具提交：replace_text_by_regex、replace_block、insert_blocks、create_document、create_group、submit_document_edits。跨文档或复杂修改统一使用 submit_document_edits。工具成功只表示提案已捕获并等待用户确认。',
      input.outputContract
        ? ''
        : '最终回复使用简短自然语言。成功提交提案工具后不要再次输出 JSON、工具参数或重复正文；没有写入建议时直接回答、说明限制或提出必要问题。',
      input.outputContract?.systemInstruction ?? '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tools: activeToolSet,
    activeTools: activeToolNames,
    stopWhen: stepCountIs(policy.maxToolRounds),
    maxRetries: policy.maxRetries,
    maxOutputTokens: resolveAgentOutputTokenLimit(input.settings.maxTokens, policy),
    onStepStart: ({ stepNumber }) => {
      const displayStep = stepNumber + 1
      const occurredAt = Date.now()
      stepStartedAt.set(stepNumber, occurredAt)
      input.onProgress?.({
        phase: 'planning',
        detail:
          displayStep === 1
            ? '第 1 轮：正在判断任务和所需资料'
            : `第 ${displayStep} 轮：正在根据工具结果判断下一步`,
        timelineEvent: {
          id: `step:${input.taskId}:${stepNumber}`,
          kind: 'step_started',
          status: 'running',
          detail:
            displayStep === 1 ? '正在判断任务和所需资料' : '正在根据上一轮 Observation 判断下一步',
          occurredAt,
          completedAt: null,
          stepNumber: displayStep,
        },
      })
    },
    onStepEnd: ({ stepNumber, toolCalls, finishReason }) => {
      const displayStep = stepNumber + 1
      const detail =
        toolCalls.length > 0
          ? `已完成判断并发起 ${toolCalls.length} 个工具调用`
          : finishReason === 'stop'
            ? '已完成判断，准备整理最终结果'
            : `本轮结束：${finishReason}`
      input.onProgress?.({
        phase: 'planning',
        detail: `第 ${displayStep} 轮：${detail}`,
        timelineEvent: {
          id: `step:${input.taskId}:${stepNumber}`,
          kind: 'step_completed',
          status: 'completed',
          detail,
          occurredAt: stepStartedAt.get(stepNumber) ?? Date.now(),
          completedAt: Date.now(),
          stepNumber: displayStep,
        },
      })
    },
    ...samplingParameters(input.settings),
  })
  input.onProgress?.({ phase: 'planning', detail: '正在判断需要读取哪些资料' })
  const liveReasoning = createLiveReasoningEmitter((delta) => input.onDelta?.(delta, 'reasoning'))
  let result: {
    text: string
    steps: Array<{ reasoningText?: string }>
    reasoningText?: string
    finishReason: string
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  }
  try {
    const streamResult = await agent.stream({
      prompt: [input.prompt, input.context ? `\n当前上下文：\n${input.context}` : ''].join(''),
      abortSignal: input.signal,
      timeout: { totalMs: policy.maxDurationMs },
    })
    for await (const part of streamResult.fullStream) {
      if (part.type === 'reasoning-delta') liveReasoning.push(part.delta)
    }
    const [text, steps, reasoningText, finishReason, usage] = await Promise.all([
      streamResult.text,
      streamResult.steps,
      streamResult.reasoningText,
      streamResult.finishReason,
      streamResult.usage,
    ])
    result = { text, steps, reasoningText, finishReason, usage }
  } catch (error) {
    if (inFlightTools.size > 0) await Promise.allSettled([...inFlightTools])
    if (input.signal?.aborted || isAbortError(error)) {
      throw normalizeAbortError(input.signal?.reason ?? error)
    }
    throw error
  }

  const reasoningText = collectReasoningText(result)
  const channelOutput = resolveAgentOutputChannels(result.text, reasoningText)
  if (channelOutput.reasoningForDisplay && !liveReasoning.hasEmitted()) {
    input.onDelta?.(channelOutput.reasoningForDisplay, 'reasoning')
  }
  if (input.outputContract) {
    const validated = validateAgentOutputContract(input.outputContract, result.text, reasoningText)
    return {
      output: JSON.stringify(validated),
      rounds: result.steps.length,
      toolCalls: calls,
      finishReason: result.finishReason,
      usage: projectLanguageModelUsage(result.usage),
    }
  }
  input.onProgress?.({ phase: 'finalizing', detail: '正在整理可确认的修改' })
  let parsedOutput =
    proposedCommands.length > 0 || proposedPatches.length > 0
      ? createCapturedProposalOutput({
          commands: proposedCommands,
          patches: proposedPatches,
          text: result.text,
          structuredOutput: channelOutput.output,
        })
      : channelOutput.output
  if (!parsedOutput) {
    parsedOutput = createNaturalAgentTextOutput(result.text)
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
  return {
    output,
    rounds: result.steps.length,
    toolCalls: calls,
    finishReason: result.finishReason,
    usage: projectLanguageModelUsage(result.usage),
  }
}

function createLiveReasoningEmitter(emit: (delta: string) => void): {
  push: (delta: string) => void
  hasEmitted: () => boolean
} {
  let decision: 'pending' | 'display' | 'suppress' = 'pending'
  let pending = ''
  let emitted = false
  return {
    push(delta) {
      if (!delta || decision === 'suppress') return
      if (decision === 'display') {
        emitted = true
        emit(delta)
        return
      }
      pending += delta
      const trimmed = pending.trimStart()
      if (!trimmed) return
      if (/^(?:\{|\[|```(?:json)?)/i.test(trimmed)) {
        decision = 'suppress'
        pending = ''
        return
      }
      decision = 'display'
      emitted = true
      emit(pending)
      pending = ''
    },
    hasEmitted: () => emitted,
  }
}

function projectLanguageModelUsage(usage?: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}) {
  if (!usage) return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
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

export function resolveAgentOutputChannels(text: string, reasoningText: string) {
  const textOutput = normalizeAgentOutputCandidate(text)
  const reasoningOutput = normalizeAgentOutputCandidate(reasoningText)
  return {
    output: textOutput ?? reasoningOutput,
    reasoningForDisplay: reasoningOutput ? '' : reasoningText.trim(),
  }
}

export function createNaturalAgentTextOutput(value: string): z.infer<typeof agentOutputSchema> {
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
  commands: AgentCommand[]
  patches: AgentPatch[]
  text: string
  structuredOutput?: z.infer<typeof agentOutputSchema> | null
}): z.infer<typeof agentOutputSchema> {
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

export function normalizeAgentOutputCandidate(
  value: string,
): z.infer<typeof agentOutputSchema> | null {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let bestOutput: z.infer<typeof agentOutputSchema> | null = null
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
      // DeepSeek 等兼容模型可能在合法对象后继续输出解释或示例；继续寻找下一个对象。
    }
  }
  return bestOutput
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

function normalizeParsedAgentOutput(
  parsedJson: Record<string, unknown>,
): z.infer<typeof agentOutputSchema> | null {
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

export function normalizeAgentOutputForTaskIntent(
  output: z.infer<typeof agentOutputSchema>,
  _prompt: string,
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
  return output
}

function getToolProgressLabel(name: string, completed: boolean): string {
  const labels: Record<string, [string, string]> = {
    get_current_document: ['正在读取当前页面', '已读取当前页面'],
    get_selected_blocks: ['正在确认选中的内容', '已确认选中的内容'],
    get_document_outline: ['正在查看页面结构', '已查看页面结构'],
    search_documents: ['正在知识库中查找资料', '已完成知识库检索'],
    list_document_groups: ['正在查找文档分组', '已找到文档分组'],
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
    replace_text_by_regex: ['正在提交文本替换提案', '文本替换提案已就绪'],
    replace_block: ['正在提交块修改提案', '块修改提案已就绪'],
    insert_blocks: ['正在提交内容插入提案', '内容插入提案已就绪'],
    create_document: ['正在生成文档提案', '文档提案已就绪'],
    create_group: ['正在生成分组提案', '分组提案已就绪'],
    submit_document_edits: ['正在提交多文档修改提案', '多文档修改提案已就绪'],
  }
  return labels[name]?.[completed ? 1 : 0] ?? (completed ? '工具调用已完成' : '正在调用工具')
}

function getToolFailureProgressLabel(name: string): string {
  return `${getToolProgressLabel(name, false).replace(/^正在/, '')}失败`
}

function policyAllowsToolName(
  name: string,
  policy: ReturnType<typeof normalizeExecutionPolicy>,
): boolean {
  return (
    policy.allowedTools.includes(name) ||
    (name.startsWith('mcp__') && policy.allowedTools.includes('mcp:*'))
  )
}

function createToolTimelineEvent(call: AgentToolCall, detail: string): AgentTimelineEvent {
  return {
    id: `tool:${call.id}`,
    kind: 'tool',
    status:
      call.status === 'running' ? 'running' : call.status === 'completed' ? 'completed' : 'failed',
    detail,
    occurredAt: call.startedAt,
    completedAt: call.completedAt,
    toolCallId: call.id,
  }
}

function createToolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw normalizeAbortError(signal.reason)
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      globalThis.clearTimeout(timeout)
      reject(normalizeAbortError(signal?.reason))
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function normalizeAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('Agent Provider 请求已取消。')
  error.name = 'AbortError'
  return error
}
