import { z } from 'zod'

import type { AgentToolCall } from '@/models/agent/agentTool'
import type { AgentRuntimeInput } from '@/services/agent/AgentRuntime'
import type { AgentToolExecutionResult } from '@/services/agent/AgentToolExecutor'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import type { AgentPatchProposal, AgentWriteCommand } from '@/services/agent/AgentWriteContract'
import type { AgentExternalTool } from '@/models/integrations/mcp'
import { getAgentToolDefinition } from '@/services/agent/AgentToolRegistry'
import { throwIfAgentToolAborted } from '@/services/agent/AgentToolCancellation'
import { redactSensitiveText, redactSensitiveValue, safeAuditJson } from '@/services/security/SensitiveDataRedaction'
import { agentOutputSchema } from '@/services/agent/AgentOutputNormalizer'
import {
  createToolCallSignature,
  createToolTimelineEvent,
  getToolFailureProgressLabel,
  getToolProgressLabel,
  isAbortError,
  waitForRetry,
} from '@/services/agent/AgentToolLifecycle'
import { assertDisjointCommandTargets, documentEditProposalSchema } from './agentRuntimeSchemas'

/** Mutable shared state for the tool execution lifecycle within a single agent run. */
export interface ToolLifecycleContext {
  input: AgentRuntimeInput
  policy: ExecutionPolicy
  calls: AgentToolCall[]
  callCounts: Map<string, number>
  externalTools: Map<string, AgentExternalTool>
  proposedCommands: AgentWriteCommand[]
  proposedPatches: AgentPatchProposal[]
  inFlightTools: Set<Promise<unknown>>
  failedCallSignatures: Set<string>
  stepStartedAt: Map<number, number>
  resolvedStepDecisions: Set<number>
  activeStepNumber: number
  failures: number
}

export function emitToolDecision(
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
      ? `下一步检索知识库，查询"${query}"，确认相关资料。`
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
  if (toolName === 'request_authorizer_input') return '下一步请求授权人决策，获得继续执行所需的信息。'
  const label = getToolProgressLabel(toolName, false).replace(/^正在/, '')
  return `下一步${label}，获取继续判断所需的 Observation。`
}

export async function executeTracked(
  ctx: ToolLifecycleContext,
  name: string,
  args: Record<string, unknown>,
  options?: { internalExecute?: () => Promise<AgentToolExecutionResult> },
): Promise<unknown> {
  const { input, policy } = ctx
  throwIfAgentToolAborted(input.signal)
  const startedAt = Date.now()
  const callId = input.createId()
  emitToolDecision(input, {
    callId,
    toolName: name,
    args,
    stepNumber: ctx.activeStepNumber,
    stepStartedAt: ctx.stepStartedAt,
    resolvedStepDecisions: ctx.resolvedStepDecisions,
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
  const externalDefinition = ctx.externalTools.get(name)
  const nextCount = (ctx.callCounts.get(name) ?? 0) + 1
  ctx.callCounts.set(name, nextCount)
  let execution: AgentToolExecutionResult = { ok: false, error: '工具未执行。' }
  let executionWasAborted = false
  const policyAllowsTool =
    policy.allowedTools.includes(name) ||
    (name.startsWith('mcp__') && policy.allowedTools.includes('mcp:*'))
  const signature = createToolCallSignature(name, args)
  if (ctx.failedCallSignatures.has(signature)) {
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
        execution = options?.internalExecute
          ? await options.internalExecute()
          : await input.executeTool({
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
  ctx.calls.push(call)
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
    ctx.failedCallSignatures.add(signature)
    ctx.failures += 1
    if (ctx.failures >= policy.maxToolFailures) throw new Error('Agent 工具失败次数达到上限。')
    return { ok: false, error: safeExecutionError }
  }
  return safeValue
}

export function execute(
  ctx: ToolLifecycleContext,
  name: string,
  args: Record<string, unknown>,
  options?: { internalExecute?: () => Promise<AgentToolExecutionResult> },
): Promise<unknown> {
  const lifecycle = executeTracked(ctx, name, args, options)
  ctx.inFlightTools.add(lifecycle)
  void lifecycle.finally(() => ctx.inFlightTools.delete(lifecycle)).catch(() => undefined)
  return lifecycle
}

export async function captureProposal(
  ctx: ToolLifecycleContext,
  name: string,
  args: Record<string, unknown>,
  capture: () => void,
): Promise<unknown> {
  const { input, policy } = ctx
  const startedAt = Date.now()
  const callId = input.createId()
  emitToolDecision(input, {
    callId,
    toolName: name,
    args,
    stepNumber: ctx.activeStepNumber,
    stepStartedAt: ctx.stepStartedAt,
    resolvedStepDecisions: ctx.resolvedStepDecisions,
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
  const nextCount = (ctx.callCounts.get(name) ?? 0) + 1
  ctx.callCounts.set(name, nextCount)
  let error: string | null = null
  if (ctx.failedCallSignatures.has(signature)) {
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
  ctx.calls.push(call)
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
    ctx.failedCallSignatures.add(signature)
    ctx.failures += 1
    if (ctx.failures >= policy.maxToolFailures) throw new Error('Agent 工具失败次数达到上限。')
    return { ok: false, error }
  }
  return value
}

export function captureCommand(
  ctx: ToolLifecycleContext,
  command: AgentWriteCommand,
): Promise<unknown> {
  return captureProposal(ctx, command.tool, command, () => {
    if (ctx.proposedPatches.length > 0) throw new Error('commands 和 patches 不能混合提交。')
    const candidate = [...ctx.proposedCommands, command]
    assertDisjointCommandTargets(candidate)
    const validated = agentOutputSchema.safeParse({
      outcome: 'proposal',
      commands: candidate,
      patches: [],
      finalAnswer: '',
    })
    if (!validated.success) throw new Error(validated.error.issues[0]?.message ?? '提案无效。')
    ctx.proposedCommands.push(command)
  })
}

export function captureDocumentEdits(
  ctx: ToolLifecycleContext,
  args: z.infer<typeof documentEditProposalSchema>,
): Promise<unknown> {
  return captureProposal(ctx, 'submit_document_edits', args, () => {
    if (ctx.proposedCommands.length > 0 || ctx.proposedPatches.length > 0) {
      throw new Error('一个任务只能提交一批最终写入提案。')
    }
    const proposal = documentEditProposalSchema.parse(args)
    ctx.input.validateDocumentEditProposal?.(proposal)
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
    ctx.proposedPatches.push(...patches)
  })
}
