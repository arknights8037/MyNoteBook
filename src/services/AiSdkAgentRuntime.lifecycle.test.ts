import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiSettings } from '@/models/ai'
import type { AgentToolCall } from '@/models/agentTool'

const agentHarness = vi.hoisted(() => ({
  resultText: '已完成检查。',
  reasoningDeltas: [] as string[],
  textDeltas: [] as string[],
  instructions: '',
  options: {} as Record<string, unknown>,
  repairResult: null as null | {
    text: string
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  },
  streamError: null as Error | null,
  run: null as
    | null
    | ((tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>) => Promise<void>),
}))

vi.mock('ai', () => ({
  generateText: vi.fn(async () => {
    if (!agentHarness.repairResult) throw new Error('Unexpected structured repair call')
    return agentHarness.repairResult
  }),
  jsonSchema: (schema: unknown) => schema,
  Output: {
    object: (options: unknown) => ({ name: 'object', options }),
  },
  stepCountIs: () => () => false,
  tool: (definition: unknown) => definition,
  ToolLoopAgent: class {
    private readonly tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>

    constructor(options: {
      tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>
      instructions: string
      onStepStart?: (event: { stepNumber: number }) => void
      onStepEnd?: (event: {
        stepNumber: number
        toolCalls: unknown[]
        finishReason: string
      }) => void
    }) {
      this.tools = options.tools
      agentHarness.instructions = options.instructions
      agentHarness.options = options
    }

    async stream() {
      const options = agentHarness.options as {
        onStepStart?: (event: { stepNumber: number }) => void
        onStepEnd?: (event: {
          stepNumber: number
          toolCalls: unknown[]
          finishReason: string
        }) => void
      }
      const tools = this.tools
      const rejected: Array<(error: Error) => void> = []
      const derived = <T>(value: T): Promise<T> =>
        agentHarness.streamError
          ? new Promise<T>((_resolve, reject) => rejected.push(reject))
          : Promise.resolve(value)
      async function* fullStream() {
        options.onStepStart?.({ stepNumber: 0 })
        if (agentHarness.streamError) {
          rejected.forEach((reject) => reject(new Error('No output generated')))
          throw agentHarness.streamError
        }
        for (const delta of agentHarness.reasoningDeltas) {
          yield { type: 'reasoning-delta' as const, id: 'reasoning-1', delta }
        }
        for (const text of agentHarness.textDeltas) {
          yield { type: 'text-delta' as const, id: 'text-1', text }
        }
        await agentHarness.run?.(tools)
        options.onStepEnd?.({ stepNumber: 0, toolCalls: [], finishReason: 'stop' })
      }
      return {
        fullStream: fullStream(),
        text: derived(agentHarness.resultText),
        steps: derived([]),
        reasoningText: derived(agentHarness.reasoningDeltas.join('')),
        finishReason: derived('stop'),
        usage: derived({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
        output: derived(undefined),
      }
    }
  },
}))

vi.mock('./AiSdkProvider', () => ({ createAiSdkModel: () => ({}) }))

import { runAiSdkAgent } from './AiSdkAgentRuntime'
import { COGNITIVE_TEST_OUTPUT_CONTRACT } from './CognitiveRegistry'

function settings() {
  const value = createAiSettings('openai')
  value.model = 'gpt-4o'
  return value
}

describe('AI SDK Agent tool lifecycle', () => {
  beforeEach(() => {
    agentHarness.resultText = '已完成检查。'
    agentHarness.reasoningDeltas = []
    agentHarness.textDeltas = []
    agentHarness.instructions = ''
    agentHarness.options = {}
    agentHarness.repairResult = null
    agentHarness.streamError = null
    agentHarness.run = async (tools) => {
      await tools.search_documents?.execute({ query: 'Agent loop' })
    }
  })

  it('settles derived stream promises when the provider request fails', async () => {
    agentHarness.streamError = new Error('Insufficient Balance')

    await expect(
      runAiSdkAgent({
        taskId: 'task-provider-error',
        prompt: '分析资料',
        context: '',
        settings: settings(),
        systemPrompt: '',
        createId: () => 'call-provider-error',
        executeTool: vi.fn(),
        recordToolCall: vi.fn(),
      }),
    ).rejects.toThrow('Insufficient Balance')
  })

  it('does not execute a tool when the running audit record cannot be written', async () => {
    const executeTool = vi.fn(async () => ({ ok: true, value: [] }))
    const recordToolCall = vi.fn(async () => {
      throw new Error('audit unavailable')
    })

    await expect(
      runAiSdkAgent({
        taskId: 'task-audit-failure',
        prompt: '检查资料',
        context: '',
        settings: settings(),
        systemPrompt: '',
        createId: () => 'call-audit-failure',
        executeTool,
        recordToolCall,
      }),
    ).rejects.toThrow('audit unavailable')

    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('writes running before execution and then updates the same call to completed', async () => {
    const events: string[] = []
    const records: AgentToolCall[] = []
    const executeTool = vi.fn(async (request) => {
      events.push('execute')
      return { ok: true, value: [{ title: 'Agent 设计' }], request }
    })

    await runAiSdkAgent({
      taskId: 'task-lifecycle',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-lifecycle',
      executeTool,
      recordToolCall: async (call) => {
        events.push(`audit:${call.status}`)
        records.push({ ...call })
      },
    })

    expect(events).toEqual(['audit:running', 'execute', 'audit:completed'])
    expect(records.map((call) => call.id)).toEqual(['call-lifecycle', 'call-lifecycle'])
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-lifecycle', name: 'search_documents' }),
    )
  })

  it('shows a model-authored auditable decision summary without exposing hidden reasoning', async () => {
    const progress: Array<{ detail: string; timelineEvent?: { detail: string } }> = []
    agentHarness.run = async (tools) => {
      await tools.report_progress?.execute({
        summary: '目标分组尚未确认',
        evidence: '用户要求写入 Agent MVP，但当前只有分组名称，没有稳定 ID。',
        nextAction: '查询文档分组并取得真实 ID。',
      })
    }

    await runAiSdkAgent({
      taskId: 'task-visible-decision',
      prompt: '写入 Agent MVP',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-visible-decision',
      executeTool: vi.fn(),
      recordToolCall: vi.fn(),
      onProgress: (update) => progress.push(update),
    })

    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: '目标分组尚未确认',
          timelineEvent: expect.objectContaining({
            detail: expect.stringContaining('下一步：查询文档分组并取得真实 ID。'),
          }),
        }),
      ]),
    )
    expect(agentHarness.instructions).toContain('过程透明要求')
    expect(agentHarness.instructions).toContain('不得填写隐藏思维链')
  })

  it('only exposes policy-allowed tools and forwards the retry limit', async () => {
    agentHarness.run = async (tools) => {
      expect(Object.keys(tools)).toEqual(['submit_document_edits'])
    }

    await runAiSdkAgent({
      taskId: 'task-policy-tools',
      prompt: '修订提案',
      context: '',
      settings: settings(),
      systemPrompt: '',
      executionPolicy: {
        version: 1,
        maxToolRounds: 6,
        maxDurationMs: 60_000,
        maxToolFailures: 2,
        tokenBudget: 16_384,
        allowedTools: ['submit_document_edits'],
        riskLevel: 'propose_write',
        allowUserInput: false,
        allowWriteProposals: true,
        maxRetries: 0,
      },
      createId: () => 'call-policy-tools',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
    })

    expect(agentHarness.options).toMatchObject({
      activeTools: ['submit_document_edits'],
      maxRetries: 0,
    })
    expect(agentHarness.instructions).toContain('本次 Runtime 实际可用工具：submit_document_edits')
  })

  it('emits a visible decision before its tool and a summary decision at the end', async () => {
    agentHarness.run = async (tools) => {
      await tools.search_documents?.execute({ query: '制度' })
    }
    const progress: Array<{ detail: string; timelineEvent?: { kind: string; status: string } }> = []

    await runAiSdkAgent({
      taskId: 'task-step-progress',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-step-progress',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      onProgress: (update) => progress.push(update),
    })

    const events = progress.flatMap((update) =>
      update.timelineEvent ? [update.timelineEvent] : [],
    )
    const decisionIndex = events.findIndex(
      (event) => event.kind === 'decision' && event.status === 'completed',
    )
    const toolIndex = events.findIndex((event) => event.kind === 'tool')
    expect(decisionIndex).toBeGreaterThanOrEqual(0)
    expect(toolIndex).toBeGreaterThan(decisionIndex)
    expect(events[decisionIndex]).toMatchObject({
      detail: expect.stringContaining('下一步检索知识库'),
      stepNumber: 1,
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary', status: 'running' }),
        expect.objectContaining({ kind: 'summary', status: 'completed' }),
      ]),
    )
  })

  it('forwards reasoning deltas before the tool loop finishes', async () => {
    let releaseToolLoop!: () => void
    const toolLoopGate = new Promise<void>((resolve) => {
      releaseToolLoop = () => resolve()
    })
    agentHarness.reasoningDeltas = ['正在检查', '相关资料。']
    agentHarness.run = async () => toolLoopGate
    const deltas: string[] = []

    const run = runAiSdkAgent({
      taskId: 'task-live-reasoning',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-live-reasoning',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      onDelta: (delta, channel) => {
        if (channel === 'reasoning') deltas.push(delta)
      },
    })

    await vi.waitFor(() => expect(deltas.join('')).toBe('正在检查相关资料。'))
    releaseToolLoop()
    await run
  })

  it('streams a natural-language Agent answer without waiting for the run to finish', async () => {
    let releaseRun!: () => void
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    agentHarness.resultText = '这是直接回答。'
    agentHarness.textDeltas = ['这是', '直接回答。']
    agentHarness.run = async () => runGate
    const deltas: string[] = []

    const run = runAiSdkAgent({
      taskId: 'task-live-content',
      prompt: '直接回答',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-live-content',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      onDelta: (delta, channel) => {
        if (channel === 'content') deltas.push(delta)
      },
    })

    await vi.waitFor(() => expect(deltas.join('')).toBe('这是直接回答。'))
    releaseRun()
    await run
  })

  it('does not stream JSON protocol text as visible Agent content', async () => {
    agentHarness.resultText = '{"outcome":"no_change","finalAnswer":"完成"}'
    agentHarness.textDeltas = ['{', '"outcome":"no_change"}']
    agentHarness.run = async () => undefined
    const onDelta = vi.fn()

    await runAiSdkAgent({
      taskId: 'task-hidden-content-protocol',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-hidden-content-protocol',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      onDelta,
    })

    expect(onDelta).not.toHaveBeenCalled()
  })

  it('does not expose streamed structured protocol as reasoning', async () => {
    agentHarness.reasoningDeltas = ['```json\n', '{"outcome":"no_change"}', '\n```']
    const onDelta = vi.fn()

    await runAiSdkAgent({
      taskId: 'task-hidden-protocol',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-hidden-protocol',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      onDelta,
    })

    expect(onDelta).not.toHaveBeenCalled()
  })

  it('does not execute an identical failed tool call twice', async () => {
    agentHarness.run = async (tools) => {
      await tools.search_documents?.execute({ query: 'same failure' })
      await tools.search_documents?.execute({ query: 'same failure' })
    }
    const executeTool = vi.fn(async () => ({ ok: false, error: 'temporary failure' }))

    await runAiSdkAgent({
      taskId: 'task-duplicate-failure',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: (() => {
        let index = 0
        return () => `call-duplicate-failure-${++index}`
      })(),
      executeTool,
      recordToolCall: async () => undefined,
    })

    expect(executeTool).toHaveBeenCalledOnce()
  })

  it('automatically retries an explicitly retryable read failure', async () => {
    const progress: Array<{ timelineEvent?: { kind: string } }> = []
    const executeTool = vi.fn()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      executeTool.mockResolvedValueOnce({
        ok: false,
        error: 'database busy',
        errorCode: 'database_busy',
        retryable: true,
        retryAfterMs: 0,
      })
    }
    executeTool.mockResolvedValueOnce({ ok: true, value: [{ title: 'Recovered' }] })

    await runAiSdkAgent({
      taskId: 'task-read-retry',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-read-retry',
      executeTool,
      recordToolCall: async () => undefined,
      onProgress: (update) => progress.push(update),
    })

    expect(executeTool).toHaveBeenCalledTimes(5)
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ timelineEvent: expect.objectContaining({ kind: 'retry' }) }),
      ]),
    )
  })

  it('can submit a corrected proposal after nine earlier tool failures', async () => {
    let proposalResult: unknown
    agentHarness.run = async (tools) => {
      for (let index = 0; index < 9; index += 1) {
        await tools.search_documents?.execute({ query: `failed-read-${index}` })
      }
      proposalResult = await tools.submit_document_edits?.execute({
        documents: [
          {
            documentId: 'doc-1',
            edits: [
              {
                kind: 'replace',
                targetBlockIds: ['block-1'],
                content: '修正后的内容',
                reason: '根据已完成读取提交增量提案',
              },
            ],
          },
        ],
        summary: '提交修正后的增量提案',
      })
    }

    const result = await runAiSdkAgent({
      taskId: 'task-failure-headroom',
      prompt: '读取后提交增量提案',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: (() => {
        let index = 0
        return () => `call-failure-headroom-${++index}`
      })(),
      executeTool: async () => ({ ok: false, error: 'read failed' }),
      recordToolCall: async () => undefined,
    })

    expect(proposalResult).toMatchObject({ proposalCaptured: true })
    expect(JSON.parse(result.output)).toMatchObject({ outcome: 'proposal' })
  })

  it('records a cancelled in-flight tool before rejecting the run', async () => {
    const controller = new AbortController()
    const records: AgentToolCall[] = []
    const executeTool = vi.fn(
      (request: { signal?: AbortSignal }) =>
        new Promise<{ ok: boolean }>((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
            { once: true },
          )
          controller.abort()
        }),
    )

    await expect(
      runAiSdkAgent({
        taskId: 'task-cancel',
        prompt: '检查资料',
        context: '',
        settings: settings(),
        systemPrompt: '',
        signal: controller.signal,
        createId: () => 'call-cancel',
        executeTool,
        recordToolCall: async (call) => {
          records.push({ ...call })
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(records.map((call) => call.status)).toEqual(['running', 'failed'])
    expect(records.at(-1)?.error).toContain('取消')
  })

  it('normalizes a Provider cancellation wrapper to AbortError', async () => {
    const controller = new AbortController()
    agentHarness.run = async () => {
      controller.abort('provider wrapper')
      throw new Error('SDK wrapped abort')
    }

    await expect(
      runAiSdkAgent({
        taskId: 'task-provider-cancel',
        prompt: '取消 Provider',
        context: '',
        settings: settings(),
        systemPrompt: '',
        signal: controller.signal,
        createId: () => 'call-provider-cancel',
        executeTool: async () => ({ ok: true }),
        recordToolCall: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('redacts sensitive tool arguments, observations and audit errors', async () => {
    let observation: unknown
    agentHarness.run = async (tools) => {
      observation = await tools.search_documents?.execute({
        query: 'Agent loop',
        apiKey: 'sk-argument-secret',
      })
    }
    const records: AgentToolCall[] = []

    await runAiSdkAgent({
      taskId: 'task-sensitive-result',
      prompt: '检查资料',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-sensitive-result',
      executeTool: async () => ({
        ok: true,
        value: {
          title: '结果',
          headers: { authorization: 'Bearer provider-result-secret' },
        },
      }),
      recordToolCall: async (call) => {
        records.push({ ...call })
      },
    })

    expect(observation).toEqual({
      title: '结果',
      headers: { authorization: '[REDACTED]' },
    })
    expect(records.at(0)?.argumentsJson).not.toContain('sk-argument-secret')
    expect(records.at(-1)?.resultJson).not.toContain('provider-result-secret')
  })

  it('rejects overlapping complex patches inside the proposal tool', async () => {
    let proposalResult: unknown
    agentHarness.run = async (tools) => {
      proposalResult = await tools.submit_document_edits?.execute({
        documents: [
          {
            documentId: 'doc-1',
            edits: [
              {
                kind: 'replace',
                targetBlockIds: ['block-1'],
                content: '替换后的完整内容',
                reason: '更新状态',
              },
              {
                kind: 'insert_after',
                anchorBlockId: 'block-1',
                content: '补充说明',
                reason: '增加约束',
              },
            ],
          },
        ],
        summary: '同步更新',
      })
    }
    const records: AgentToolCall[] = []

    const result = await runAiSdkAgent({
      taskId: 'task-overlapping-patches',
      prompt: '更新同一块并补充说明',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-overlapping-patches',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async (call) => {
        records.push({ ...call })
      },
    })

    expect(proposalResult).toMatchObject({
      ok: false,
      error: expect.stringContaining('同一文档内'),
    })
    expect(records.at(-1)).toMatchObject({
      toolName: 'submit_document_edits',
      status: 'failed',
      error: expect.stringContaining('合并成一个 replace edit'),
    })
    expect(JSON.parse(result.output)).toMatchObject({ outcome: 'no_change', patches: [] })
  })

  it('captures grouped edits for multiple documents as one proposal', async () => {
    const validateDocumentEditProposal = vi.fn()
    agentHarness.run = async (tools) => {
      await tools.submit_document_edits?.execute({
        documents: [
          {
            documentId: 'doc-1',
            edits: [
              {
                kind: 'replace',
                targetBlockIds: ['block-1'],
                content: '文档一更新',
                reason: '同步事实',
              },
            ],
          },
          {
            documentId: 'doc-2',
            edits: [
              {
                kind: 'insert_after',
                anchorBlockId: 'block-2',
                content: '文档二补充',
                reason: '同步事实',
              },
            ],
          },
        ],
        summary: '同步两个文档中的同一事实',
      })
    }

    const result = await runAiSdkAgent({
      taskId: 'task-multi-document-edits',
      prompt: '同步多个文档',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: () => 'call-multi-document-edits',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      validateDocumentEditProposal,
    })

    expect(validateDocumentEditProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        documents: [
          expect.objectContaining({ documentId: 'doc-1' }),
          expect.objectContaining({ documentId: 'doc-2' }),
        ],
      }),
    )
    expect(JSON.parse(result.output).patches).toMatchObject([
      {
        documentId: 'doc-1',
        operation: 'replace',
        blockId: 'block-1',
        targetBlockIds: ['block-1'],
      },
      {
        documentId: 'doc-2',
        operation: 'insert_after',
        blockId: 'block-2',
        targetBlockIds: ['block-2'],
      },
    ])
  })

  it('rejects repeated command targets before they reach result persistence', async () => {
    const commandResults: unknown[] = []
    agentHarness.run = async (tools) => {
      commandResults.push(
        await tools.replace_block?.execute({ blockId: 'block-1', content: '更新状态' }),
      )
      commandResults.push(
        await tools.insert_blocks?.execute({
          anchorBlockId: 'block-1',
          position: 'after',
          content: '补充约束',
        }),
      )
    }
    const records: AgentToolCall[] = []

    await runAiSdkAgent({
      taskId: 'task-overlapping-commands',
      prompt: '更新同一块并补充说明',
      context: '',
      settings: settings(),
      systemPrompt: '',
      createId: (() => {
        let index = 0
        return () => `call-overlapping-command-${++index}`
      })(),
      executeTool: async () => ({ ok: true }),
      recordToolCall: async (call) => {
        records.push({ ...call })
      },
    })

    expect(commandResults[0]).toMatchObject({ proposalCaptured: true })
    expect(commandResults[1]).toMatchObject({
      ok: false,
      error: expect.stringContaining('同一个目标块'),
    })
    expect(records.at(-1)).toMatchObject({
      toolName: 'insert_blocks',
      status: 'failed',
    })
  })

  it('runs the same tool loop with an injected cognitive output contract', async () => {
    agentHarness.run = async () => undefined
    agentHarness.resultText = '{"summary":"认知结果","items":[{"kind":"claim","text":"结论"}]}'
    agentHarness.textDeltas = ['{"summary":"认知', '结果","items":[]}']
    const progress: string[] = []

    const result = await runAiSdkAgent({
      taskId: 'task-cognitive-contract',
      prompt: '测试认知契约',
      context: '',
      settings: settings(),
      systemPrompt: '',
      outputContract: COGNITIVE_TEST_OUTPUT_CONTRACT,
      createId: () => 'call-cognitive-contract',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
      onProgress: (update) => progress.push(update.detail),
    })

    expect(JSON.parse(result.output)).toEqual({
      summary: '认知结果',
      items: [{ kind: 'claim', text: '结论' }],
    })
    expect(agentHarness.instructions).toContain('cognitive-test v1')
    expect(agentHarness.instructions).toContain('JSON Schema')
    expect(agentHarness.instructions).toContain('"required":["summary","items"]')
    expect(agentHarness.options.output).toMatchObject({
      name: 'object',
      options: { name: 'cognitive-test' },
    })
    expect(agentHarness.instructions).not.toContain('最终回复使用简短自然语言')
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.stringContaining('正在生成结构化结果 · 已接收'),
        expect.stringContaining('结构化结果接收完成'),
        expect.stringContaining('结构化结果已校验'),
      ]),
    )
  })

  it('repairs a provider response that ignores structured output without rerunning tools', async () => {
    agentHarness.resultText = 'The task result is not JSON.'
    agentHarness.repairResult = {
      text: '{"summary":"修复后的结果","items":[]}',
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
    }

    const result = await runAiSdkAgent({
      taskId: 'task-cognitive-repair',
      prompt: '测试认知契约修复',
      context: '',
      settings: settings(),
      systemPrompt: '',
      outputContract: COGNITIVE_TEST_OUTPUT_CONTRACT,
      createId: () => 'call-cognitive-repair',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
    })

    expect(JSON.parse(result.output)).toEqual({ summary: '修复后的结果', items: [] })
    expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 8, totalTokens: 22 })
  })
})
