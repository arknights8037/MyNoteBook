import type { AgentToolCall } from '@/models/agent/agentTool'
import { createDefaultAgentExecutionPolicy } from '@/services/agent/AgentToolRegistry'
import type { AgentRuntimeInput, AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import { normalizeExecutionPolicy } from '@/models/agent/executionPolicy'
import { resolveProviderCapabilities } from '@/models/agent/providerCapabilities'
import type { AgentPatchProposal, AgentWriteCommand } from '@/services/agent/AgentWriteContract'
import {
  AgentRuntimeContractError,
  type AgentRunRequestV1,
  type AgentRunResult,
  type AgentRunSteerInput,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener,
  type AgentRuntimePort,
} from '@/models/agent/agentRuntimeContract'
import { createAiSettings } from '@/models/ai/ai'
import type { AgentToolExecutionResult, AgentToolRequest } from '@/services/agent/AgentToolExecutor'
import type { AgentOutputContract } from '@/services/agent/AgentOutputContract'
import type { AgentAuthorizationRequest } from '@/models/agent/agentRuntime'
import type { AgentExternalTool } from '@/models/integrations/mcp'

import type { ToolLifecycleContext } from './agentRuntime/agentRuntimeToolLifecycle'
import { buildAgentToolSet } from './agentRuntime/agentRuntimeToolDefinitions'
import { runAgentStream } from './agentRuntime/agentRuntimeStream'

export {
  createCapturedProposalOutput,
  createNaturalAgentTextOutput,
  normalizeAgentOutputCandidate,
  normalizeAgentOutputForTaskIntent,
  parseAiSdkAgentOutput,
  resolveAgentOutputChannels,
} from '@/services/agent/AgentOutputNormalizer'

export async function runAiSdkAgent(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const policy = normalizeExecutionPolicy(
    input.executionPolicy ?? createDefaultAgentExecutionPolicy(input.settings.maxTokens),
  )
  if (!resolveProviderCapabilities(input.settings.provider, input.settings.model).toolChoice) {
    throw new Error('当前模型不支持 Agent 工具调用，请选择支持原生工具调用的模型。')
  }

  const calls: AgentToolCall[] = []
  const externalTools = new Map(
    (input.externalTools ?? []).map((definition) => [definition.runtimeName, definition]),
  )
  const proposedCommands: AgentWriteCommand[] = []
  const proposedPatches: AgentPatchProposal[] = []

  const ctx: ToolLifecycleContext = {
    input,
    policy,
    calls,
    callCounts: new Map(),
    externalTools,
    proposedCommands,
    proposedPatches,
    inFlightTools: new Set(),
    failedCallSignatures: new Set(),
    completedReadSignatures: new Set(),
    stepStartedAt: new Map(),
    resolvedStepDecisions: new Set(),
    activeStepNumber: 0,
    activeTurnId: null,
    failures: 0,
  }

  const { activeToolSet, activeToolNames } = buildAgentToolSet(ctx, policy)

  return runAgentStream({ input, policy, activeToolSet, activeToolNames, ctx })
}

export interface AiSdkAgentRuntimeAdapterDependencies {
  createId: () => string
  resolveCredential: (provider: AgentRunRequestV1['modelPolicy']['provider']) => Promise<string>
  executeTool: (request: AgentToolRequest) => Promise<AgentToolExecutionResult>
  recordToolCall: (call: AgentToolCall) => Promise<void>
  requestAuthorizerInput?: (
    request: Omit<AgentAuthorizationRequest, 'id'> & { id?: string },
  ) => Promise<string>
  answerAuthorization?: (authorizationId: string, answer: string) => boolean
  resolveOutputContract?: (
    descriptor: NonNullable<AgentRunRequestV1['outputContract']>,
  ) => AgentOutputContract<unknown> | null
  validateDocumentEditProposal?: AgentRuntimeInput['validateDocumentEditProposal']
}

interface ActiveAdapterRun {
  request: AgentRunRequestV1
  abortController: AbortController
  sequence: number
  terminal: boolean
}

export class AiSdkAgentRuntimeAdapter implements AgentRuntimePort {
  private readonly claimedRunIds = new Set<string>()
  private readonly activeRuns = new Map<string, ActiveAdapterRun>()
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()

  constructor(private readonly dependencies: AiSdkAgentRuntimeAdapterDependencies) {}

  async startRun(request: AgentRunRequestV1): Promise<AgentRunResult> {
    if (this.claimedRunIds.has(request.runId)) {
      throw new AgentRuntimeContractError('duplicate_run', `run_id ${request.runId} 已经启动。`)
    }
    this.claimedRunIds.add(request.runId)
    const active: ActiveAdapterRun = {
      request,
      abortController: new AbortController(),
      sequence: 0,
      terminal: false,
    }
    this.activeRuns.set(request.runId, active)
    this.emit(active, 'run.started', { objective: request.objective })
    this.emit(active, 'model.started', {
      provider: request.modelPolicy.provider,
      model: request.modelPolicy.model,
    })
    this.emit(active, 'message.started', { channel: 'assistant' })

    try {
      const settings = createAiSettings(request.modelPolicy.provider)
      settings.endpoint = request.modelPolicy.endpoint
      settings.model = request.modelPolicy.model
      settings.temperature = request.modelPolicy.temperature
      settings.topP = request.modelPolicy.topP
      settings.reasoningEffort = request.modelPolicy.reasoningEffort
      settings.maxTokens = request.modelPolicy.maxOutputTokens
      settings.apiKey = await this.dependencies.resolveCredential(request.modelPolicy.provider)
      const outputContract = request.outputContract
        ? this.dependencies.resolveOutputContract?.(request.outputContract)
        : undefined
      if (request.outputContract && !outputContract) {
        throw new Error(
          `Output Contract ${request.outputContract.id} v${request.outputContract.version} 未注册。`,
        )
      }

      const { runAgentToolLoop } = await import('@/services/agent/AgentRuntime')
      const result = await runAgentToolLoop({
        taskId: request.workItemId,
        runId: request.runId,
        prompt: request.objective,
        context: request.compiledContext,
        settings,
        systemPrompt: request.systemInstructions,
        intent: request.intent,
        signal: active.abortController.signal,
        createId: this.dependencies.createId,
        executeTool: this.dependencies.executeTool,
        recordToolCall: this.dependencies.recordToolCall,
        requestAuthorizerInput: this.dependencies.requestAuthorizerInput,
        externalTools: toExternalTools(request),
        executionPolicy: constrainPolicyToManifest(request),
        outputContract: outputContract ?? undefined,
        validateDocumentEditProposal: this.dependencies.validateDocumentEditProposal,
        onDelta: (delta, channel = 'content') => {
          this.emit(active, 'message.progress', { channel, delta })
        },
        onProgress: (update) => {
          this.emit(active, 'run.progress', {
            phase: update.phase,
            toolName: update.toolName,
            detail: update.detail,
            timelineEvent: update.timelineEvent,
          })
          if (update.toolCall) {
            const lifecycle =
              update.toolCall.status === 'running' || update.toolCall.status === 'pending'
                ? 'started'
                : update.toolCall.status === 'completed'
                  ? 'completed'
                  : active.abortController.signal.aborted
                    ? 'cancelled'
                    : 'failed'
            this.emit(active, `tool.${lifecycle}`, { toolCall: update.toolCall })
          }
        },
      })
      this.emit(active, 'message.completed', {
        output: result.output,
        structuredOutput: result.structuredOutput,
      })
      this.emit(active, 'model.completed', {
        finishReason: result.finishReason,
        usage: result.usage,
        rounds: result.rounds,
        structuredOutput: result.structuredOutput,
      })
      this.emitTerminal(active, 'run.completed', {
        finishReason: result.finishReason,
        usage: result.usage,
        rounds: result.rounds,
      })
      return {
        runId: request.runId,
        ...result,
        usage: result.usage
          ? { ...result.usage, modelTurns: result.rounds }
          : { modelTurns: result.rounds },
      }
    } catch (error) {
      const cancelled = active.abortController.signal.aborted || isAbortError(error)
      const message = error instanceof Error ? error.message : String(error)
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
    if (!active) throw new AgentRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    active.abortController.abort()
  }

  async steerRun(runId: string, input: AgentRunSteerInput): Promise<void> {
    if (!this.activeRuns.has(runId)) {
      throw new AgentRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    }
    if (input.kind !== 'authorization_response' || !input.answer.trim()) {
      throw new AgentRuntimeContractError('invalid_steer', 'Runtime v1 只接受非空授权回复。')
    }
    if (!this.dependencies.answerAuthorization?.(input.authorizationId, input.answer)) {
      throw new AgentRuntimeContractError('authorization_not_found', '授权请求不存在或已经结束。')
    }
  }

  async requestAuthorization(
    runId: string,
    request: Omit<AgentAuthorizationRequest, 'id'> & { id?: string },
  ): Promise<string> {
    const active = this.activeRuns.get(runId)
    if (!active) throw new AgentRuntimeContractError('run_not_found', `run_id ${runId} 未运行。`)
    if (!this.dependencies.requestAuthorizerInput) {
      throw new AgentRuntimeContractError('authorization_not_found', 'Runtime 没有授权输入通道。')
    }
    const authorizationId = request.id ?? this.dependencies.createId()
    this.emit(active, 'authorization.started', {
      authorizationId,
      question: request.question,
      context: request.context,
      options: request.options,
      allowFreeText: request.allowFreeText,
    })
    try {
      const answer = await this.dependencies.requestAuthorizerInput({
        ...request,
        id: authorizationId,
      })
      this.emit(active, 'authorization.completed', { authorizationId, answer })
      return answer
    } catch (error) {
      const cancelled = active.abortController.signal.aborted || isAbortError(error)
      this.emit(active, cancelled ? 'authorization.cancelled' : 'authorization.failed', {
        authorizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
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

  private emit(
    active: ActiveAdapterRun,
    type: AgentRuntimeEvent['type'],
    payload: Record<string, unknown>,
  ): void {
    const event: AgentRuntimeEvent = {
      version: 1,
      eventId: this.dependencies.createId(),
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
    active: ActiveAdapterRun,
    type: 'run.completed' | 'run.failed' | 'run.cancelled',
    payload: Record<string, unknown>,
  ): void {
    if (active.terminal) return
    active.terminal = true
    this.emit(active, type, payload)
  }
}

function toExternalTools(request: AgentRunRequestV1): AgentExternalTool[] {
  return request.toolManifest.flatMap((tool) => {
    if (tool.source.kind !== 'mcp') return []
    return [
      {
        serverId: tool.source.serverId,
        serverName: tool.source.serverName,
        name: tool.source.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.source.readOnly,
        serverTrusted: tool.source.serverTrusted,
        runtimeName: tool.name,
        executionAuthorization: tool.executionAuthorization,
        mutationApproval: tool.mutationApproval,
        externalActionApproval: tool.externalActionApproval,
        maxCallsPerRun: tool.maxCallsPerRun,
        tags: tool.tags,
        presentation: {
          label: tool.presentation.label,
          category: 'external',
        },
      },
    ]
  })
}

function constrainPolicyToManifest(
  request: AgentRunRequestV1,
): AgentRunRequestV1['executionPolicy'] {
  const names = new Set(request.toolManifest.map((tool) => tool.name))
  const hasMcpTools = request.toolManifest.some((tool) => tool.source.kind === 'mcp')
  return {
    ...request.executionPolicy,
    allowedTools: request.executionPolicy.allowedTools.filter(
      (name) => names.has(name) || (name === 'mcp:*' && hasMcpTools),
    ),
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
