import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiSettings } from '@/models/ai'
import type { AgentToolCall } from '@/models/agentTool'

const agentHarness = vi.hoisted(() => ({
  resultText: '已完成检查。',
  instructions: '',
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
    }) {
      this.tools = options.tools
      agentHarness.instructions = options.instructions
    }

    async generate() {
      await agentHarness.run?.(this.tools)
      return { text: agentHarness.resultText, steps: [], reasoningText: '' }
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
    agentHarness.instructions = ''
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
