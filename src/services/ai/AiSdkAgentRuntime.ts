import {
  generateText,
  jsonSchema,
  Output,
  ToolLoopAgent,
  stepCountIs,
  tool,
  type ToolSet,
} from 'ai'
import { z } from 'zod'

import type { AgentToolCall } from '@/models/agent/agentTool'
import { createAiSdkModel } from '@/services/ai/AiSdkProvider'
import {
  createDefaultAgentExecutionPolicy,
  AGENT_TOOL_REGISTRY,
  getAgentToolDefinition,
  resolveAgentOutputTokenLimit,
} from '@/services/agent/AgentToolRegistry'
import type { AgentRuntimeInput, AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import { normalizeExecutionPolicy } from '@/models/agent/executionPolicy'
import type { AiSettings } from '@/models/ai/ai'
import { resolveProviderCapabilities } from '@/models/agent/providerCapabilities'
import { throwIfAgentToolAborted } from '@/services/agent/AgentToolCancellation'
import type { AgentToolExecutionResult } from '@/services/agent/AgentToolExecutor'
import { redactSensitiveText, redactSensitiveValue, safeAuditJson } from '@/services/security/SensitiveDataRedaction'
import {
  formatAgentOutputContractInstruction,
  validateAgentOutputContract,
  type AgentOutputContract,
} from '@/services/agent/AgentOutputContract'
import {
  createDocumentCommandSchema,
  createGroupCommandSchema,
  insertBlocksCommandSchema,
  regexReplaceCommandSchema,
  replaceBlockCommandSchema,
  type AgentPatchProposal,
  type AgentWriteCommand,
} from '@/services/agent/AgentWriteContract'
import {
  agentOutputSchema,
  createCapturedProposalOutput,
  createNaturalAgentTextOutput,
  normalizeAgentOutputForTaskIntent,
  resolveAgentOutputChannels,
} from '@/services/agent/AgentOutputNormalizer'
import {
  collectReasoningText,
  createLiveReasoningEmitter,
  mergeLanguageModelUsage,
  projectLanguageModelUsage,
  samplingParameters,
} from '@/services/agent/AgentStreamSupport'
import {
  createToolCallSignature,
  createToolTimelineEvent,
  getToolFailureProgressLabel,
  getToolProgressLabel,
  isAbortError,
  normalizeAbortError,
  policyAllowsToolName,
  waitForRetry,
} from '@/services/agent/AgentToolLifecycle'

export {
  createCapturedProposalOutput,
  createNaturalAgentTextOutput,
  normalizeAgentOutputCandidate,
  normalizeAgentOutputForTaskIntent,
  parseAiSdkAgentOutput,
  resolveAgentOutputChannels,
} from '@/services/agent/AgentOutputNormalizer'

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

function assertDisjointCommandTargets(commands: AgentWriteCommand[]): void {
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
  const proposedCommands: AgentWriteCommand[] = []
  const proposedPatches: AgentPatchProposal[] = []
  const inFlightTools = new Set<Promise<unknown>>()
  const failedCallSignatures = new Set<string>()
  const stepStartedAt = new Map<number, number>()
  const resolvedStepDecisions = new Set<number>()
  let activeStepNumber = 0
  let failures = 0

  const executeTracked = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    throwIfAgentToolAborted(input.signal)
    const startedAt = Date.now()
    const callId = input.createId()
    emitToolDecision(input, {
      callId,
      toolName: name,
      args,
      stepNumber: activeStepNumber,
      stepStartedAt,
      resolvedStepDecisions,
    })
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
            ? Math.min(policy.maxRetries, 4)
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
    emitToolDecision(input, {
      callId,
      toolName: name,
      args,
      stepNumber: activeStepNumber,
      stepStartedAt,
      resolvedStepDecisions,
    })
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

  const captureCommand = async (command: AgentWriteCommand): Promise<unknown> =>
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
    report_progress: tool({
      description:
        '向用户显示当前阶段的可审计决策摘要。summary 说明当前判断，evidence 只引用已观察到的事实或工具返回，nextAction 说明下一步；不要写隐藏思维链、逐步内心推理或未经观察的猜测。',
      inputSchema: z.object({
        summary: z.string().min(1).max(300),
        evidence: z.string().min(1).max(500),
        nextAction: z.string().min(1).max(300),
      }),
      execute: async (args) => {
        const definition = getAgentToolDefinition('report_progress')!
        const nextCount = (callCounts.get('report_progress') ?? 0) + 1
        callCounts.set('report_progress', nextCount)
        if (nextCount > definition.maxCallsPerTask) {
          return { ok: false, error: '过程摘要超过单任务调用上限。' }
        }
        const summary = redactSensitiveText(args.summary)
        const evidence = redactSensitiveText(args.evidence)
        const nextAction = redactSensitiveText(args.nextAction)
        const occurredAt = Date.now()
        resolvedStepDecisions.add(activeStepNumber)
        input.onProgress?.({
          phase: 'planning',
          toolName: 'report_progress',
          detail: summary,
          timelineEvent: {
            id: `decision:${input.taskId}:${activeStepNumber}`,
            kind: 'decision',
            status: 'completed',
            detail: `${summary}\n依据：${evidence}\n下一步：${nextAction}`,
            occurredAt: stepStartedAt.get(activeStepNumber) ?? occurredAt,
            completedAt: occurredAt,
            stepNumber: activeStepNumber + 1,
          },
        })
        return { ok: true, visibleToUser: true }
      },
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
    create_mcp_server_draft: tool({
      description:
        '用户明确要求添加 MCP 服务时使用。工具会先请求确认，再写入停用且未信任的配置草稿；不会连接、启动或加载该服务。不要把令牌、密码、Cookie 或 Authorization header 放入参数。',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        transport: z.enum(['stdio', 'http']),
        command: z.string().min(1).max(1_000).optional(),
        args: z.array(z.string().max(2_000)).max(64).optional(),
        cwd: z.string().min(1).max(2_000).optional(),
        url: z.string().url().max(4_000).optional(),
      }),
      execute: (args) => execute('create_mcp_server_draft', args),
    }),
    replace_text_by_regex: tool({
      description:
        '提交一个正则文本替换提案，进入用户确认队列；不会立即写入。仅在已经读取并确认目标范围后调用。',
      inputSchema: regexReplaceCommandSchema.omit({ tool: true }),
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
      input.outputContract ? formatAgentOutputContractInstruction(input.outputContract) : '',
      '过程透明要求：开始执行时先调用 report_progress；每次获得会改变后续动作的关键 Observation 后，在调用下一个业务工具或生成最终结果前再次调用 report_progress；改变计划或准备提交提案时也必须报告。summary、evidence、nextAction 会作为三个自然段直接展示给用户，因此要具体说明正在做什么、刚得到什么以及接下来做什么。只写可审计的决策摘要，不得填写隐藏思维链、逐步内心推理或无法从上下文验证的猜测。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tools: activeToolSet,
    activeTools: activeToolNames,
    stopWhen: stepCountIs(policy.maxToolRounds),
    maxRetries: policy.maxRetries,
    maxOutputTokens: resolveAgentOutputTokenLimit(input.settings.maxTokens, policy),
    ...(input.outputContract
      ? {
          output: createAgentStructuredOutput(input.outputContract),
        }
      : {}),
    onStepStart: ({ stepNumber }) => {
      activeStepNumber = stepNumber
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
          id: `decision:${input.taskId}:${stepNumber}`,
          kind: 'decision',
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
      if (toolCalls.length > 0) return
      const displayStep = stepNumber + 1
      const detail =
        finishReason === 'stop'
          ? '信息已足够；下一步不再调用工具，整理最终 summary。'
          : `本轮未调用工具，结束原因：${finishReason}`
      input.onProgress?.({
        phase: 'planning',
        detail: `第 ${displayStep} 轮：${detail}`,
        timelineEvent: {
          id: `decision:${input.taskId}:${stepNumber}`,
          kind: 'decision',
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
  const liveContent = createLiveReasoningEmitter((delta) => input.onDelta?.(delta, 'content'))
  let result: {
    text: string
    steps: Array<{ reasoningText?: string }>
    reasoningText?: string
    finishReason: string
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    structuredOutput?: unknown
  }
  let streamResult: Awaited<ReturnType<typeof agent.stream>> | null = null
  let structuredCharacterCount = 0
  let lastStructuredProgressAt = 0
  const structuredStartedAt = Date.now()
  try {
    streamResult = await agent.stream({
      prompt: [input.prompt, input.context ? `\n当前上下文：\n${input.context}` : ''].join(''),
      abortSignal: input.signal,
      timeout: { totalMs: policy.maxDurationMs },
    })
    for await (const part of streamResult.fullStream) {
      if (part.type === 'reasoning-delta') liveReasoning.push(part.delta)
      if (!input.outputContract && part.type === 'text-delta') {
        liveContent.push(String(Reflect.get(part, 'text') ?? Reflect.get(part, 'delta') ?? ''))
      }
      if (input.outputContract && part.type === 'text-delta') {
        const delta = String(Reflect.get(part, 'text') ?? Reflect.get(part, 'delta') ?? '')
        structuredCharacterCount += delta.length
        const now = Date.now()
        if (structuredCharacterCount === delta.length || now - lastStructuredProgressAt >= 500) {
          lastStructuredProgressAt = now
          emitStructuredOutputProgress(
            input,
            structuredCharacterCount,
            structuredStartedAt,
            'streaming',
          )
        }
      }
    }
    if (input.outputContract) {
      emitStructuredOutputProgress(
        input,
        structuredCharacterCount,
        structuredStartedAt,
        'validating',
      )
    }
    const [text, steps, reasoningText, finishReason, usage] = await Promise.all([
      streamResult.text,
      streamResult.steps,
      streamResult.reasoningText,
      streamResult.finishReason,
      streamResult.usage,
    ])
    let structuredOutput: unknown
    if (input.outputContract) {
      try {
        structuredOutput = await streamResult.output
      } catch {
        structuredOutput = undefined
      }
    }
    result = { text, steps, reasoningText, finishReason, usage, structuredOutput }
  } catch (error) {
    if (streamResult) await settleStreamResult(streamResult)
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
  emitSummaryProgress(input, 'running')
  if (input.outputContract) {
    let validated: unknown
    try {
      validated =
        result.structuredOutput === undefined
          ? validateAgentOutputContract(input.outputContract, result.text, reasoningText)
          : input.outputContract.validate(result.structuredOutput)
    } catch (error) {
      const repaired = await repairAgentOutputContract({
        contract: input.outputContract,
        text: result.text,
        reasoningText,
        settings: input.settings,
        signal: input.signal,
        maxRetries: policy.maxRetries,
        initialError: error,
      })
      validated = repaired.value
      result.usage = mergeLanguageModelUsage(result.usage, repaired.usage)
    }
    emitStructuredOutputProgress(input, structuredCharacterCount, structuredStartedAt, 'completed')
    emitSummaryProgress(input, 'completed')
    return {
      output: JSON.stringify(validated),
      rounds: result.steps.length,
      toolCalls: calls,
      finishReason: result.finishReason,
      usage: projectLanguageModelUsage(result.usage),
    }
  }
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
  emitSummaryProgress(input, 'completed')
  return {
    output,
    rounds: result.steps.length,
    toolCalls: calls,
    finishReason: result.finishReason,
    usage: projectLanguageModelUsage(result.usage),
  }
}

async function settleStreamResult(streamResult: object): Promise<void> {
  const pending = ['text', 'steps', 'reasoningText', 'finishReason', 'usage', 'output']
    .map((key) => Reflect.get(streamResult, key))
    .filter((value): value is PromiseLike<unknown> =>
      Boolean(value && typeof value.then === 'function'),
    )
  await Promise.allSettled(pending)
}

function emitStructuredOutputProgress(
  input: AgentRuntimeInput,
  characterCount: number,
  occurredAt: number,
  status: 'streaming' | 'validating' | 'completed',
): void {
  const detail =
    status === 'streaming'
      ? `正在生成结构化结果 · 已接收 ${characterCount.toLocaleString()} 字符`
      : status === 'validating'
        ? `结构化结果接收完成 · ${characterCount.toLocaleString()} 字符，正在校验`
        : `结构化结果已校验 · ${characterCount.toLocaleString()} 字符`
  input.onProgress?.({
    phase: 'finalizing',
    detail,
    timelineEvent: {
      id: `structured-output:${input.taskId}`,
      kind: 'summary',
      status: status === 'completed' ? 'completed' : 'running',
      detail,
      occurredAt,
      completedAt: status === 'completed' ? Date.now() : null,
    },
  })
}

function emitToolDecision(
  input: AgentRuntimeInput,
  decision: {
    callId: string
    toolName: string
    args: Record<string, unknown>
    stepNumber: number
    stepStartedAt: Map<number, number>
    resolvedStepDecisions: Set<number>
  },
): void {
  const firstDecisionInStep = !decision.resolvedStepDecisions.has(decision.stepNumber)
  decision.resolvedStepDecisions.add(decision.stepNumber)
  const occurredAt = Date.now()
  input.onProgress?.({
    phase: 'planning',
    toolName: decision.toolName,
    detail: createToolDecisionSummary(decision.toolName, decision.args),
    timelineEvent: {
      id: firstDecisionInStep
        ? `decision:${input.taskId}:${decision.stepNumber}`
        : `decision:${input.taskId}:${decision.stepNumber}:${decision.callId}`,
      kind: 'decision',
      status: 'completed',
      detail: createToolDecisionSummary(decision.toolName, decision.args),
      occurredAt:
        (firstDecisionInStep && decision.stepStartedAt.get(decision.stepNumber)) ?? occurredAt,
      completedAt: occurredAt,
      stepNumber: decision.stepNumber + 1,
    },
  })
}

function createToolDecisionSummary(toolName: string, args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? redactSensitiveText(args.query).slice(0, 120) : ''
  const documentId =
    typeof args.documentId === 'string' ? redactSensitiveText(args.documentId).slice(0, 80) : ''
  if (toolName === 'search_documents') {
    return query
      ? `下一步检索知识库，查询“${query}”，确认相关资料。`
      : '下一步检索知识库，定位相关资料。'
  }
  if (toolName === 'read_document') {
    return documentId
      ? `下一步读取文档 ${documentId}，核对正文与稳定来源。`
      : '下一步读取目标文档，核对正文与稳定来源。'
  }
  if (toolName === 'get_current_document') return '下一步读取当前文档，建立本轮判断上下文。'
  if (toolName === 'get_selected_blocks') return '下一步读取当前选区，确认用户指定范围。'
  if (toolName === 'get_document_outline') return '下一步读取文档大纲，确认结构和目标位置。'
  if (toolName === 'request_authorizer_input') return '下一步请求授权人决策，获得继续执行所需信息。'
  const label = getToolProgressLabel(toolName, false).replace(/^正在/, '')
  return `下一步${label}，获取继续判断所需的 Observation。`
}

function emitSummaryProgress(input: AgentRuntimeInput, status: 'running' | 'completed'): void {
  const occurredAt = Date.now()
  input.onProgress?.({
    phase: 'finalizing',
    detail: status === 'running' ? '正在生成最终 summary' : '最终 summary 已生成',
    timelineEvent: {
      id: `summary:${input.taskId}`,
      kind: 'summary',
      status,
      detail: status === 'running' ? '汇总决策、工具 Observation 与结论。' : '已完成结果汇总。',
      occurredAt,
      completedAt: status === 'completed' ? occurredAt : null,
    },
  })
}

function createAgentStructuredOutput(contract: AgentOutputContract<unknown>) {
  return Output.object({
    schema: jsonSchema(contract.jsonSchema),
    name: contract.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
    description: `${contract.id} v${contract.version} structured result`,
  })
}

async function repairAgentOutputContract(input: {
  contract: AgentOutputContract<unknown>
  text: string
  reasoningText: string
  settings: AiSettings
  signal?: AbortSignal
  maxRetries: number
  initialError: unknown
}): Promise<{
  value: unknown
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}> {
  let lastError = input.initialError
  const attempts = Math.max(1, Math.min(input.maxRetries, 2))
  const source = [input.text, input.reasoningText].filter((value) => value.trim()).join('\n\n')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const repaired = await generateText({
        model: createAiSdkModel(input.settings),
        system: formatAgentOutputContractInstruction(input.contract),
        prompt: [
          '将下面的原始任务结果转换为 contract 要求的单个 JSON 对象。',
          '只整理已有信息；不要调用工具、补造来源或输出解释。',
          `原始任务结果：\n${source.slice(0, 24_000)}`,
        ].join('\n\n'),
        maxRetries: 0,
        maxOutputTokens: input.settings.maxTokens,
        abortSignal: input.signal,
        ...samplingParameters(input.settings),
      })
      return {
        value: validateAgentOutputContract(input.contract, repaired.text),
        usage: repaired.usage,
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
