import { generateText, jsonSchema, Output, ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'

import type { AgentRuntimeInput, AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import type { AiSettings } from '@/models/ai/ai'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import { createAiSdkModel } from '@/services/ai/AiSdkProvider'
import { resolveAgentOutputTokenLimit } from '@/services/agent/AgentToolRegistry'
import {
  formatAgentOutputContractInstruction,
  validateAgentOutputContract,
  type AgentOutputContract,
} from '@/services/agent/AgentOutputContract'
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
import { isAbortError, normalizeAbortError } from '@/services/agent/AgentToolLifecycle'
import type { ToolLifecycleContext } from './agentRuntimeToolLifecycle'

export interface AgentStreamConfig {
  input: AgentRuntimeInput
  policy: ExecutionPolicy
  activeToolSet: ToolSet
  activeToolNames: string[]
  ctx: ToolLifecycleContext
}

export async function runAgentStream(config: AgentStreamConfig): Promise<AgentRuntimeResult> {
  const { input, policy, activeToolSet, activeToolNames, ctx } = config

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
      '读取约束：read_document 返回的是按稳定块分页的 canonical Markdown，不是默认整篇读取。结果中的 blocks/returnedBlocks 表示本页块范围，truncated/nextCursor 表示后续页。优先用搜索片段和 blockIds 定向读取；只有结论确实依赖未返回部分时才用 nextCursor 续页。不得用相同 documentId、cursor、maxChars、blockIds 重复读取，Runtime 会复用而不再次访问文件。',
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
      ctx.activeStepNumber = stepNumber
      const displayStep = stepNumber + 1
      const occurredAt = Date.now()
      ctx.stepStartedAt.set(stepNumber, occurredAt)
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
          occurredAt: ctx.stepStartedAt.get(stepNumber) ?? Date.now(),
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
    if (ctx.inFlightTools.size > 0) await Promise.allSettled([...ctx.inFlightTools])
    if (input.signal?.aborted || isAbortError(error)) {
      throw normalizeAbortError(input.signal?.reason ?? error)
    }
    throw error
  }

  return resolveStreamOutput(config, result, liveReasoning, structuredCharacterCount, structuredStartedAt)
}

async function resolveStreamOutput(
  config: AgentStreamConfig,
  result: {
    text: string
    steps: Array<{ reasoningText?: string }>
    reasoningText?: string
    finishReason: string
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    structuredOutput?: unknown
  },
  liveReasoning: ReturnType<typeof createLiveReasoningEmitter>,
  structuredCharacterCount: number,
  structuredStartedAt: number,
): Promise<AgentRuntimeResult> {
  const { input, policy, ctx } = config

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
      toolCalls: ctx.calls,
      finishReason: result.finishReason,
      usage: projectLanguageModelUsage(result.usage),
    }
  }
  let parsedOutput =
    ctx.proposedCommands.length > 0 || ctx.proposedPatches.length > 0
      ? createCapturedProposalOutput({
          commands: ctx.proposedCommands,
          patches: ctx.proposedPatches,
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
    toolCalls: ctx.calls,
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

export function emitStructuredOutputProgress(
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

export function emitSummaryProgress(input: AgentRuntimeInput, status: 'running' | 'completed'): void {
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
