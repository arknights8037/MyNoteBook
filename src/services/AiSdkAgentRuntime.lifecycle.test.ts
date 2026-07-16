import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiSettings } from '@/models/ai'
import type { AgentToolCall } from '@/models/agentTool'

const agentHarness = vi.hoisted(() => ({
  resultText: '已完成检查。',
  reasoningDeltas: [] as string[],
  instructions: '',
  options: {} as Record<string, unknown>,
  run: null as
    | null
    | ((tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>) => Promise<void>),
}))

vi.mock('ai', () => ({
  generateText: vi.fn(),
  jsonSchema: (schema: unknown) => schema,
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
      async function* fullStream() {
        options.onStepStart?.({ stepNumber: 0 })
        for (const delta of agentHarness.reasoningDeltas) {
          yield { type: 'reasoning-delta' as const, id: 'reasoning-1', delta }
        }
        await agentHarness.run?.(tools)
        options.onStepEnd?.({ stepNumber: 0, toolCalls: [], finishReason: 'stop' })
      }
      return {
        fullStream: fullStream(),
        text: Promise.resolve(agentHarness.resultText),
        steps: Promise.resolve([]),
        reasoningText: Promise.resolve(agentHarness.reasoningDeltas.join('')),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
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
    agentHarness.instructions = ''
    agentHarness.options = {}
    agentHarness.run = async (tools) => {
      await tools.search_documents?.execute({ query: 'Agent loop' })
    }
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

  it('emits model step events around the tool loop', async () => {
    agentHarness.run = async () => undefined
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

    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timelineEvent: expect.objectContaining({ kind: 'step_started', status: 'running' }),
        }),
        expect.objectContaining({
          timelineEvent: expect.objectContaining({ kind: 'step_completed', status: 'completed' }),
        }),
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
    const executeTool = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'database busy',
        errorCode: 'database_busy',
        retryable: true,
        retryAfterMs: 0,
      })
      .mockResolvedValueOnce({ ok: true, value: [{ title: 'Recovered' }] })

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

    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ timelineEvent: expect.objectContaining({ kind: 'retry' }) }),
      ]),
    )
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
    })

    expect(JSON.parse(result.output)).toEqual({
      summary: '认知结果',
      items: [{ kind: 'claim', text: '结论' }],
    })
    expect(agentHarness.instructions).toContain('cognitive-test v1')
    expect(agentHarness.instructions).not.toContain('最终回复使用简短自然语言')
  })
})
