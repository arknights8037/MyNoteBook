import {
  AgentRuntimeContractError,
  type AgentRunRequestV1,
  type AgentRunSteerInput,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener,
  type AgentRuntimePort,
  type AgentToolCall,
  type DomainToolManifestEntry,
} from '@mynotebook/agent-runtime-contracts'
import { Agent, type AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'

import { adaptDomainTools, ensureToolCall, type PiToolAdapterContext } from './PiToolAdapter.js'
import type { PiAgentRuntimeDependencies, PiPrototypeRunResult } from './types.js'

interface ActivePiRun {
  request: AgentRunRequestV1
  agent: Agent
  sequence: number
  terminal: boolean
  cancelRequested: boolean
  failureReason: string | null
  turnId: string | null
  rounds: number
  calls: AgentToolCall[]
  callsByProviderId: Map<string, AgentToolCall>
  recordTasks: Promise<void>[]
  toolContext: PiToolAdapterContext
}

export class PiAgentRuntimePrototype implements AgentRuntimePort {
  private readonly claimedRunIds = new Set<string>()
  private readonly activeRuns = new Map<string, ActivePiRun>()
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()
  private readonly createId: () => string
  private readonly now: () => number
  private readonly redact: (value: string) => string

  constructor(private readonly dependencies: PiAgentRuntimeDependencies) {
    this.createId = dependencies.createId ?? (() => globalThis.crypto.randomUUID())
    this.now = dependencies.now ?? (() => Date.now())
    this.redact = dependencies.redact ?? redactRuntimeText
  }

  async startRun(request: AgentRunRequestV1): Promise<PiPrototypeRunResult> {
    if (this.claimedRunIds.has(request.runId)) {
      throw new AgentRuntimeContractError('duplicate_run', `run_id ${request.runId} 已经启动。`)
    }
    this.claimedRunIds.add(request.runId)

    const driver = await this.dependencies.resolveModelDriver(request.modelPolicy)
    const streamFn = ((model, context, options) =>
      driver.streamFn(model, context, {
        ...options,
        temperature: request.modelPolicy.temperature,
        maxTokens: request.modelPolicy.maxOutputTokens,
      })) satisfies typeof driver.streamFn
    const activeRef: { current: ActivePiRun | null } = { current: null }
    const toolContext: PiToolAdapterContext = {
      runId: request.runId,
      workItemId: request.workItemId,
      getTurnId: () => activeRef.current?.turnId ?? null,
      createId: this.createId,
      now: this.now,
      rpc: this.dependencies.toolRpc,
      callCounts: new Map(),
      callsByProviderId: new Map(),
      calls: [],
      auditTasks: new Map(),
      capturedDocumentEdits: [],
      capturedPatches: [],
      onCallChanged: async (call, phase, detail) => {
        const active = activeRef.current
        if (!active) throw new Error('PI Runtime tool call started before Run initialization.')
        this.emit(active, `tool.${phase}`, {
          toolCall: snapshotCall(call),
          ...(detail === undefined ? {} : { detail: redactUnknown(detail, this.redact) }),
        })
        if (this.dependencies.recordToolCall) {
          const task = this.dependencies.recordToolCall(snapshotCall(call))
          active.recordTasks.push(task)
          await task
        }
      },
    }
    const manifest = allowedManifest(request)
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(request),
        model: driver.model,
        thinkingLevel:
          request.modelPolicy.reasoningEffort === 'auto'
            ? 'off'
            : request.modelPolicy.reasoningEffort,
        tools: adaptDomainTools(manifest, toolContext),
        messages: [],
      },
      streamFn,
      getApiKey: () => this.dependencies.resolveCredential(request.modelPolicy),
      sessionId: request.sessionId,
      toolExecution:
        request.executionPolicy.budget?.maxParallelTools === 1 ? 'sequential' : 'parallel',
      afterToolCall: async (_context, signal) =>
        signal?.aborted ? { terminate: true } : undefined,
    })
    const active: ActivePiRun = {
      request,
      agent,
      sequence: 0,
      terminal: false,
      cancelRequested: false,
      failureReason: null,
      turnId: null,
      rounds: 0,
      calls: toolContext.calls,
      callsByProviderId: toolContext.callsByProviderId,
      recordTasks: [],
      toolContext,
    }
    activeRef.current = active
    this.activeRuns.set(request.runId, active)
    const unsubscribe = agent.subscribe((event) => this.projectPiEvent(active, manifest, event))
    this.emit(active, 'run.started', {
      objective: request.objective,
      runtime: 'pi-agent-core',
      contextBundleId: request.contextBundle.id,
      contextBundleHash: request.contextBundle.snapshotHash,
    })
    const durationTimer = setTimeout(() => {
      active.failureReason = `PI Run 超过 maxDurationMs=${request.executionPolicy.maxDurationMs}。`
      active.agent.abort()
    }, request.executionPolicy.maxDurationMs)

    try {
      await agent.prompt(request.objective)
      if (active.cancelRequested) throw abortError('PI Run 已取消。')
      if (active.failureReason) throw new Error(active.failureReason)
      await Promise.all(active.recordTasks)
      const assistantMessages = agent.state.messages.filter(isAssistantMessage)
      const last = assistantMessages.at(-1)
      if (!last) throw new Error('PI Runtime 没有返回 assistant message。')
      if (last.stopReason === 'error') throw new Error(last.errorMessage || 'PI 模型调用失败。')
      if (last.stopReason === 'aborted') throw abortError(last.errorMessage || 'PI Run 已取消。')

      const output = assistantMessages.flatMap(textBlocks).join('').trim()
      const reasoning = assistantMessages.flatMap(thinkingBlocks).join('').trim()
      const structuredOutput = this.validateStructuredOutput(request, output, reasoning)
      const usage = summarizeUsage(assistantMessages)
      const result: PiPrototypeRunResult = {
        runId: request.runId,
        output,
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        rounds: active.rounds,
        toolCalls: active.calls.map(snapshotCall),
        finishReason: last.stopReason,
        usage: { ...usage, modelTurns: active.rounds },
        documentEditProposals: structuredClone(active.toolContext.capturedDocumentEdits),
        patchProposals: structuredClone(active.toolContext.capturedPatches),
      }
      this.emitTerminal(active, 'run.completed', {
        finishReason: result.finishReason,
        usage: result.usage,
        rounds: result.rounds,
        proposalCount: result.patchProposals.length,
      })
      return result
    } catch (error) {
      await Promise.allSettled(active.recordTasks)
      const cancelled =
        !active.failureReason &&
        (active.cancelRequested || agent.signal?.aborted || isAbortError(error))
      const message = this.redact(error instanceof Error ? error.message : String(error))
      this.emitTerminal(active, cancelled ? 'run.cancelled' : 'run.failed', { error: message })
      throw error
    } finally {
      clearTimeout(durationTimer)
      unsubscribe()
      this.activeRuns.delete(request.runId)
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId)
    if (!active) throw new AgentRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    active.cancelRequested = true
    active.agent.abort()
    await active.agent.waitForIdle()
    await Promise.allSettled(active.recordTasks)
  }

  async steerRun(runId: string, input: AgentRunSteerInput): Promise<void> {
    if (!this.activeRuns.has(runId)) {
      throw new AgentRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    }
    if (input.kind !== 'authorization_response' || !input.answer.trim()) {
      throw new AgentRuntimeContractError('invalid_steer', 'Runtime v1 只接受非空授权回复。')
    }
    throw new AgentRuntimeContractError(
      'authorization_not_found',
      'PI Phase 2 原型没有待处理授权；仅验证 trusted + readOnly MCP 链路。',
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

  private async projectPiEvent(
    active: ActivePiRun,
    manifest: readonly DomainToolManifestEntry[],
    event: AgentEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'turn_start':
        active.rounds += 1
        if (active.rounds > maxModelTurns(active.request)) {
          active.failureReason = `PI Run 超过 maxModelTurns=${maxModelTurns(active.request)}。`
          active.agent.abort()
        }
        active.turnId = this.createId()
        this.emit(active, 'model.started', {
          turnId: active.turnId,
          turn: active.rounds,
          provider: active.request.modelPolicy.provider,
          model: active.request.modelPolicy.model,
        })
        return
      case 'turn_end': {
        const message = isAssistantMessage(event.message) ? event.message : null
        this.emit(active, 'model.completed', {
          turnId: active.turnId,
          turn: active.rounds,
          finishReason: message?.stopReason,
          usage: message ? summarizeUsage([message]) : undefined,
        })
        return
      }
      case 'message_start':
        if (isAssistantMessage(event.message)) {
          this.emit(active, 'message.started', { turnId: active.turnId, channel: 'assistant' })
        }
        return
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          this.emit(active, 'message.progress', {
            turnId: active.turnId,
            channel: 'content',
            delta: event.assistantMessageEvent.delta,
          })
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          this.emit(active, 'message.progress', {
            turnId: active.turnId,
            channel: 'reasoning',
            delta: event.assistantMessageEvent.delta,
          })
        }
        return
      case 'message_end':
        if (isAssistantMessage(event.message)) {
          this.emit(active, 'message.completed', {
            turnId: active.turnId,
            finishReason: event.message.stopReason,
          })
        }
        return
      case 'tool_execution_start': {
        const entry = manifest.find((tool) => tool.name === event.toolName)
        if (!entry) return
        const call = ensureToolCall(
          active.toolContext,
          entry,
          event.toolCallId,
          asRecord(event.args),
        )
        await active.toolContext.auditTasks.get(call.id)
        return
      }
      case 'tool_execution_end': {
        const call = active.callsByProviderId.get(event.toolCallId)
        if (!call || call.completedAt !== null) return
        call.status = event.isError ? 'failed' : 'completed'
        call.completedAt = this.now()
        call.resultJson = JSON.stringify(event.result ?? null)
        call.error = event.isError ? 'PI 工具执行失败。' : null
        await active.toolContext.onCallChanged(call, event.isError ? 'failed' : 'completed', {
          result: event.result,
        })
        return
      }
      default:
        return
    }
  }

  private validateStructuredOutput(
    request: AgentRunRequestV1,
    output: string,
    reasoning: string,
  ): unknown | undefined {
    if (!request.outputContract) return undefined
    const validator = this.dependencies.outputValidators?.resolve(request.outputContract)
    if (!validator) {
      throw new Error(
        `Output Contract ${request.outputContract.id} v${request.outputContract.version} 未注册。`,
      )
    }
    let lastError: unknown = new Error('PI structured output 无法解析。')
    for (const text of [output, reasoning]) {
      for (const candidate of extractJsonValues(text)) {
        try {
          return validator(JSON.parse(candidate))
        } catch (error) {
          lastError = error
        }
      }
    }
    throw lastError
  }

  private emit(
    active: ActivePiRun,
    type: AgentRuntimeEvent['type'],
    payload: Record<string, unknown>,
  ): void {
    const event: AgentRuntimeEvent = {
      version: 1,
      eventId: this.createId(),
      runId: active.request.runId,
      sequence: ++active.sequence,
      type,
      occurredAt: this.now(),
      correlationId: active.request.correlationId,
      causationId: active.request.causationId,
      payload,
    }
    for (const listener of this.listeners.get(active.request.runId) ?? []) listener(event)
  }

  private emitTerminal(
    active: ActivePiRun,
    type: 'run.completed' | 'run.failed' | 'run.cancelled',
    payload: Record<string, unknown>,
  ): void {
    if (active.terminal) return
    active.terminal = true
    this.emit(active, type, payload)
  }
}

function allowedManifest(request: AgentRunRequestV1): DomainToolManifestEntry[] {
  const allowed = new Set(request.executionPolicy.allowedTools)
  return request.toolManifest.filter(
    (tool) =>
      (allowed.has(tool.name) || (tool.source.kind === 'mcp' && allowed.has('mcp:*'))) &&
      tool.executionAuthorization === 'not_required',
  )
}

function maxModelTurns(request: AgentRunRequestV1): number {
  return request.executionPolicy.budget?.maxModelTurns ?? request.executionPolicy.maxToolRounds
}

function buildSystemPrompt(request: AgentRunRequestV1): string {
  return [
    request.systemInstructions,
    request.compiledContext,
    request.outputContract?.systemInstruction,
    request.outputContract
      ? `输出必须满足 JSON Schema：${JSON.stringify(request.outputContract.jsonSchema)}`
      : '',
  ]
    .filter((value) => value?.trim())
    .join('\n\n')
}

function snapshotCall(call: AgentToolCall): AgentToolCall {
  return { ...call }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'role' in message &&
    message.role === 'assistant'
  )
}

function textBlocks(message: AssistantMessage): string[] {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

function thinkingBlocks(message: AssistantMessage): string[] {
  return message.content.flatMap((block) => (block.type === 'thinking' ? [block.thinking] : []))
}

function summarizeUsage(messages: AssistantMessage[]) {
  const usage = messages.reduce(
    (total, message) => ({
      inputTokens: total.inputTokens + message.usage.input,
      outputTokens: total.outputTokens + message.usage.output,
      totalTokens: total.totalTokens + message.usage.totalTokens,
      costUsd: total.costUsd + message.usage.cost.total,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  )
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsdMicros: Math.max(0, Math.round(usage.costUsd * 1_000_000)),
  }
}

function extractJsonValues(value: string): string[] {
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const values: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"' && depth > 0) inString = true
    else if (character === '{' || character === '[') {
      if (depth === 0) start = index
      depth += 1
    } else if ((character === '}' || character === ']') && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        values.push(trimmed.slice(start, index + 1))
        start = -1
      }
    }
  }
  return values.length ? values : [trimmed]
}

function redactRuntimeText(value: string): string {
  return value
    .replace(/(api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
}

function redactUnknown(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, redact)]),
    )
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
