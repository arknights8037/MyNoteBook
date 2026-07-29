import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  generateText,
  jsonSchema,
  Output,
  stepCountIs,
  tool,
  ToolLoopAgent,
  type LanguageModel,
  type ToolSet,
} from 'ai'

import type {
  AgentRunRequestV1,
  AgentRunResult,
  AgentRunSteerInput,
  AgentRuntimeEvent,
  AgentRuntimeEventListener,
  AgentRuntimePort,
  AgentToolCall,
  DomainToolManifestEntry,
} from '@mynotebook/agent-runtime-contracts'

import type { AgentWorkerRuntimeBridge } from './AgentWorkerHost.js'

interface ActiveRun {
  request: AgentRunRequestV1
  abortController: AbortController
  sequence: number
  terminal: boolean
  turnId: string | null
  toolCalls: AgentToolCall[]
  callCounts: Map<string, number>
  commands: Array<Record<string, unknown>>
  patches: Array<Record<string, unknown>>
}

/** AI SDK runtime owned by the Node sidecar. It consumes only frozen request data and Rust RPC. */
export class AiSdkWorkerRuntime implements AgentRuntimePort {
  private readonly claimedRunIds = new Set<string>()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()

  constructor(
    private readonly bridge: AgentWorkerRuntimeBridge,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  async startRun(request: AgentRunRequestV1): Promise<AgentRunResult> {
    if (this.claimedRunIds.has(request.runId)) {
      throw new WorkerRuntimeContractError('duplicate_run', `run_id ${request.runId} 已经启动。`)
    }
    this.claimedRunIds.add(request.runId)
    const active: ActiveRun = {
      request,
      abortController: new AbortController(),
      sequence: 0,
      terminal: false,
      turnId: null,
      toolCalls: [],
      callCounts: new Map(),
      commands: [],
      patches: [],
    }
    this.activeRuns.set(request.runId, active)
    this.emit(active, 'run.started', { objective: request.objective })
    this.emit(active, 'model.started', {
      provider: request.modelPolicy.provider,
      model: request.modelPolicy.model,
    })
    this.emit(active, 'message.started', { channel: 'assistant' })

    try {
      if (!supportsToolChoice(request)) {
        throw new Error('当前模型不支持 Agent 工具调用，请选择支持原生工具调用的模型。')
      }
      const credential = await this.bridge.resolveCredential(
        {
          requestId: this.createId(),
          runId: request.runId,
          provider: request.modelPolicy.provider,
        },
        active.abortController.signal,
      )
      const tools = this.buildTools(active)
      const model = createModel(request, credential)
      const agent = new ToolLoopAgent({
        model,
        instructions: buildInstructions(request),
        tools,
        activeTools: Object.keys(tools),
        stopWhen: stepCountIs(
          request.executionPolicy.budget?.maxModelTurns ??
            request.executionPolicy.maxToolRounds + 1,
        ),
        maxRetries: request.executionPolicy.maxRetries,
        maxOutputTokens: request.modelPolicy.maxOutputTokens,
        ...samplingParameters(request),
        ...(request.outputContract
          ? {
              output: Output.object({
                schema: jsonSchema(request.outputContract.jsonSchema),
                name: request.outputContract.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
                description: `${request.outputContract.id} v${request.outputContract.version}`,
              }),
            }
          : {}),
        onStepStart: ({ stepNumber }) => {
          active.turnId = this.createId()
          this.emit(active, 'run.progress', {
            phase: 'planning',
            detail:
              stepNumber === 0
                ? '第 1 轮：正在判断任务和所需资料'
                : `第 ${stepNumber + 1} 轮：正在根据工具结果判断下一步`,
          })
        },
      })
      const stream = await agent.stream({
        prompt: [request.objective, request.compiledContext]
          .filter(Boolean)
          .join('\n\n当前上下文：\n'),
        abortSignal: active.abortController.signal,
        timeout: { totalMs: request.executionPolicy.maxDurationMs },
      })
      let streamedText = ''
      for await (const part of stream.fullStream) {
        if (part.type === 'reasoning-delta') {
          this.emit(active, 'message.progress', {
            channel: 'reasoning',
            delta: String(Reflect.get(part, 'text') ?? Reflect.get(part, 'delta') ?? ''),
          })
        } else if (part.type === 'text-delta') {
          const delta = String(Reflect.get(part, 'text') ?? Reflect.get(part, 'delta') ?? '')
          streamedText += delta
          if (!request.outputContract) {
            this.emit(active, 'message.progress', { channel: 'content', delta })
          }
        }
      }
      const [text, steps, finishReason, baseUsage] = await Promise.all([
        stream.text,
        stream.steps,
        stream.finishReason,
        stream.usage,
      ])
      let usage: SimpleUsage = {
        inputTokens: baseUsage.inputTokens,
        outputTokens: baseUsage.outputTokens,
        totalTokens: baseUsage.totalTokens,
      }
      let structuredOutput: unknown
      if (request.outputContract) {
        try {
          structuredOutput = await stream.output
        } catch (initialError) {
          const repaired = await repairStructuredOutput(
            request,
            model,
            text || streamedText,
            active.abortController.signal,
            initialError,
          )
          structuredOutput = repaired.output
          usage = mergeUsage(usage, repaired.usage)
        }
      }
      const output = request.outputContract
        ? JSON.stringify(structuredOutput)
        : JSON.stringify(resolveNaturalOutput(active, text || streamedText))
      const result: AgentRunResult = {
        runId: request.runId,
        output,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        rounds: steps.length,
        toolCalls: active.toolCalls,
        finishReason,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          modelTurns: steps.length,
        },
      }
      this.emit(active, 'message.completed', { output, structuredOutput })
      this.emit(active, 'model.completed', {
        finishReason,
        usage: result.usage,
        rounds: steps.length,
        structuredOutput,
      })
      this.emitTerminal(active, 'run.completed', {
        finishReason,
        usage: result.usage,
        rounds: steps.length,
      })
      return result
    } catch (error) {
      const cancelled = active.abortController.signal.aborted || isAbortError(error)
      const message = redactError(error)
      this.emit(active, cancelled ? 'message.cancelled' : 'message.failed', { error: message })
      this.emit(active, cancelled ? 'model.cancelled' : 'model.failed', { error: message })
      this.emitTerminal(active, cancelled ? 'run.cancelled' : 'run.failed', { error: message })
      throw error
    } finally {
      this.activeRuns.delete(request.runId)
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId)
    if (!active) throw new WorkerRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    active.abortController.abort(new DOMException('Run cancelled by Rust Core.', 'AbortError'))
  }

  async steerRun(runId: string, input: AgentRunSteerInput): Promise<void> {
    if (!this.activeRuns.has(runId)) {
      throw new WorkerRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    }
    if (input.kind !== 'authorization_response' || !input.answer.trim()) {
      throw new WorkerRuntimeContractError('invalid_steer', 'Runtime v1 只接受非空授权回复。')
    }
    throw new WorkerRuntimeContractError(
      'authorization_not_found',
      '授权回复应由 Worker Host 的 authorization.result 通道处理。',
    )
  }

  subscribeEvents(runId: string, listener: AgentRuntimeEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<AgentRuntimeEventListener>()
    listeners.add(listener)
    this.listeners.set(runId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(runId)
    }
  }

  private buildTools(active: ActiveRun): ToolSet {
    const allowed = new Set(active.request.executionPolicy.allowedTools)
    return Object.fromEntries(
      active.request.toolManifest
        .filter(
          (definition) =>
            allowed.has(definition.name) ||
            (definition.source.kind === 'mcp' && allowed.has('mcp:*')),
        )
        .map((definition) => [
          definition.name,
          tool({
            description: definition.description,
            inputSchema: jsonSchema(definition.inputSchema),
            execute: (argumentsValue, options) =>
              this.executeTool(
                active,
                definition,
                asRecord(argumentsValue),
                options?.toolCallId ?? null,
              ),
          }),
        ]),
    )
  }

  private async executeTool(
    active: ActiveRun,
    definition: DomainToolManifestEntry,
    args: Record<string, unknown>,
    providerToolCallId: string | null,
  ): Promise<unknown> {
    const count = (active.callCounts.get(definition.name) ?? 0) + 1
    active.callCounts.set(definition.name, count)
    const startedAt = Date.now()
    const callId = this.createId()
    const running: AgentToolCall = {
      id: callId,
      taskId: active.request.workItemId,
      runId: active.request.runId,
      turnId: active.turnId,
      providerToolCallId,
      toolName: definition.name,
      argumentsJson: safeJson(args),
      resultJson: null,
      status: 'running',
      startedAt,
      completedAt: null,
      error: null,
    }
    this.emit(active, 'tool.started', { toolCall: running })
    await this.bridge.recordToolCall(running, active.abortController.signal)

    let value: unknown
    let error: string | null = null
    try {
      if (count > definition.maxCallsPerRun) {
        throw new Error(`工具 ${definition.name} 超过单任务调用上限。`)
      }
      if (definition.executionAuthorization === 'required') {
        const answer = await this.bridge.requestAuthorization(
          {
            authorizationId: this.createId(),
            runId: active.request.runId,
            question: `允许调用工具“${definition.presentation.label}”吗？`,
            context: `工具：${definition.name}\n参数：${safeJson(args).slice(0, 1_000)}`,
            options: ['仅允许本次调用', '拒绝'],
            allowFreeText: false,
          },
          active.abortController.signal,
        )
        if (answer !== '仅允许本次调用') throw new Error('授权人拒绝了工具调用。')
      }
      if (definition.risk === 'write') {
        value = captureProposal(active, definition.name, args)
      } else if (definition.name === 'request_authorizer_input') {
        value = await this.bridge.requestAuthorization(
          {
            authorizationId: this.createId(),
            runId: active.request.runId,
            question: readString(args.question, '请提供继续任务所需的决定。'),
            context: readString(args.context, ''),
            options: readStringArray(args.options),
            allowFreeText: args.allowFreeText !== false,
          },
          active.abortController.signal,
        )
      } else if (definition.name === 'report_progress') {
        const summary = readString(args.summary, 'Agent 正在继续任务。')
        this.emit(active, 'run.progress', {
          phase: 'planning',
          toolName: definition.name,
          detail: summary,
        })
        value = { visibleToUser: true }
      } else {
        const result = await this.bridge.invokeTool(
          {
            requestId: this.createId(),
            runId: active.request.runId,
            turnId: active.turnId,
            internalToolCallId: callId,
            providerToolCallId,
            toolName: definition.name,
            arguments: args,
            source: definition.source,
          },
          active.abortController.signal,
        )
        if (!result.ok || result.isError) throw new Error(result.error ?? '工具调用失败。')
        value = result.value
      }
    } catch (executionError) {
      error = redactError(executionError)
    }
    const completed: AgentToolCall = {
      ...running,
      resultJson: error ? null : safeJson(value),
      status: error ? 'failed' : 'completed',
      completedAt: Date.now(),
      error,
    }
    active.toolCalls.push(completed)
    this.emit(active, error ? 'tool.failed' : 'tool.completed', { toolCall: completed })
    await this.bridge.recordToolCall(completed, active.abortController.signal)
    if (error) throw new Error(error)
    return value
  }

  private emit(
    active: ActiveRun,
    type: AgentRuntimeEvent['type'],
    payload: Record<string, unknown>,
  ): void {
    const event: AgentRuntimeEvent = {
      version: 1,
      eventId: this.createId(),
      runId: active.request.runId,
      sequence: ++active.sequence,
      type,
      occurredAt: Date.now(),
      correlationId: active.request.correlationId,
      causationId: active.request.causationId,
      payload,
    }
    for (const listener of this.listeners.get(active.request.runId) ?? []) listener(event)
  }

  private emitTerminal(
    active: ActiveRun,
    type: 'run.completed' | 'run.failed' | 'run.cancelled',
    payload: Record<string, unknown>,
  ): void {
    if (active.terminal) return
    active.terminal = true
    this.emit(active, type, payload)
  }
}

class WorkerRuntimeContractError extends Error {
  constructor(
    readonly code: 'duplicate_run' | 'run_not_found' | 'invalid_steer' | 'authorization_not_found',
    message: string,
  ) {
    super(message)
    this.name = 'AgentRuntimeContractError'
  }
}

function createModel(request: AgentRunRequestV1, apiKey: string): LanguageModel {
  const baseURL = request.modelPolicy.endpoint.replace(/\/+$/, '')
  if (request.modelPolicy.provider === 'anthropic') {
    return createAnthropic({ apiKey, baseURL, name: 'mynotebook-worker-anthropic' })(
      request.modelPolicy.model,
    )
  }
  return createOpenAICompatible({
    name: `mynotebook-worker-${request.modelPolicy.provider}`,
    apiKey,
    baseURL,
    includeUsage: true,
  })(request.modelPolicy.model)
}

function supportsToolChoice(request: AgentRunRequestV1): boolean {
  if (request.modelPolicy.provider === 'openai-compatible') return false
  if (request.modelPolicy.provider !== 'deepseek') return true
  const model = request.modelPolicy.model.trim().toLowerCase()
  return !(model.includes('reasoner') || model.includes('thinking') || model.includes('r1'))
}

function samplingParameters(request: AgentRunRequestV1): {
  temperature?: number
  topP?: number
} {
  const model = request.modelPolicy.model.trim().toLowerCase()
  const openAiReasoning = request.modelPolicy.provider === 'openai' && /^(o\d|o-|gpt-5)/.test(model)
  return openAiReasoning
    ? {}
    : {
        temperature: request.modelPolicy.temperature,
        topP: request.modelPolicy.topP,
      }
}

async function repairStructuredOutput(
  request: AgentRunRequestV1,
  model: LanguageModel,
  invalidOutput: string,
  signal: AbortSignal,
  initialError: unknown,
): Promise<{
  output: unknown
  usage: SimpleUsage
}> {
  const contract = request.outputContract
  if (!contract || request.executionPolicy.maxRetries < 1) throw initialError
  const result = await generateText({
    model,
    system: [
      contract.systemInstruction,
      '上一轮输出未通过本地结构校验。只返回修复后的 JSON 值，不要解释。',
    ].join('\n\n'),
    prompt: invalidOutput,
    output: Output.object({
      schema: jsonSchema(contract.jsonSchema),
      name: contract.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
      description: `${contract.id} v${contract.version} repair`,
    }),
    abortSignal: signal,
    maxRetries: request.executionPolicy.maxRetries - 1,
    maxOutputTokens: request.modelPolicy.maxOutputTokens,
    ...samplingParameters(request),
  })
  return { output: result.output, usage: result.usage }
}

function mergeUsage(left: SimpleUsage, right: SimpleUsage): SimpleUsage {
  const add = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
  }
}

interface SimpleUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

function buildInstructions(request: AgentRunRequestV1): string {
  return [
    request.systemInstructions,
    '所有领域事实必须通过本次冻结 Tool Manifest 中的工具读取。',
    '写入建议只能通过提案工具提交；工具成功表示提案等待用户审阅，不表示已经写入。',
    request.outputContract?.systemInstruction ?? '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function captureProposal(
  active: ActiveRun,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!active.request.executionPolicy.allowWriteProposals) {
    throw new Error('ExecutionPolicy 不允许提出写入修改。')
  }
  if (name === 'submit_document_edits') {
    if (active.commands.length || active.patches.length) {
      throw new Error('一个任务只能提交一批最终写入提案。')
    }
    const documents = Array.isArray(args.documents) ? args.documents : []
    for (const document of documents) {
      const record = asRecord(document)
      const documentId = readString(record.documentId, '')
      for (const edit of Array.isArray(record.edits) ? record.edits : []) {
        const value = asRecord(edit)
        const kind = readString(value.kind, '')
        const targetBlockIds = readStringArray(value.targetBlockIds)
        const anchorBlockId = readString(value.anchorBlockId, '')
        active.patches.push({
          documentId,
          operation: kind,
          blockId: kind === 'replace' ? (targetBlockIds[0] ?? '') : anchorBlockId,
          targetBlockIds: kind === 'replace' ? targetBlockIds : [anchorBlockId],
          after: readString(value.content, ''),
          reason: readString(value.reason, ''),
        })
      }
    }
  } else {
    if (active.patches.length) throw new Error('commands 和 patches 不能混合提交。')
    active.commands.push({ tool: name, ...args })
  }
  return { proposalCaptured: true, mutationApproval: 'required', message: '提案已进入确认队列。' }
}

function resolveNaturalOutput(active: ActiveRun, text: string): Record<string, unknown> {
  if (active.commands.length || active.patches.length) {
    return {
      outcome: 'proposal',
      commands: active.commands,
      patches: active.patches,
      finalAnswer: text.trim(),
    }
  }
  return {
    outcome: text.trim() ? 'no_change' : 'blocked',
    commands: [],
    patches: [],
    finalAnswer: text.trim() || '当前信息不足，任务无法继续。',
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'string' ? redactText(item) : item))
}

function redactError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error))
}

function redactText(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk|api)[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
