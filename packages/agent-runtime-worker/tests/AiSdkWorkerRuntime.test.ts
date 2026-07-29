import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentRunRequestV1,
  AgentToolCall,
  AgentWorkerToolInvocation,
} from '@mynotebook/agent-runtime-contracts'

const harness = vi.hoisted(() => ({
  run: null as null | ((tools: Record<string, ToolDefinition>) => Promise<void>),
  text: '已完成。',
}))

interface ToolDefinition {
  execute: (args: unknown, options?: { toolCallId?: string }) => Promise<unknown>
}

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => ({}) }))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => () => ({}),
}))
vi.mock('ai', () => ({
  generateText: vi.fn(),
  jsonSchema: (schema: unknown) => schema,
  Output: { object: (value: unknown) => value },
  stepCountIs: () => () => false,
  tool: (definition: unknown) => definition,
  ToolLoopAgent: class {
    constructor(
      private readonly options: {
        tools: Record<string, ToolDefinition>
        onStepStart?: (input: { stepNumber: number }) => void
      },
    ) {}

    async stream() {
      const tools = this.options.tools
      const run = harness.run
      const start = this.options.onStepStart
      async function* fullStream() {
        start?.({ stepNumber: 0 })
        await run?.(tools)
        yield { type: 'text-delta', text: harness.text }
      }
      return {
        fullStream: fullStream(),
        text: Promise.resolve(harness.text),
        steps: Promise.resolve([{}]),
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ inputTokens: 8, outputTokens: 4, totalTokens: 12 }),
        output: Promise.resolve(undefined),
      }
    }
  },
}))

import { AiSdkWorkerRuntime } from '../src/AiSdkWorkerRuntime.js'

describe('AiSdkWorkerRuntime', () => {
  beforeEach(() => {
    harness.text = '已完成。'
    harness.run = null
  })

  it('runs AI SDK in the sidecar and delegates read tools and audit to Rust RPC', async () => {
    const invocations: AgentWorkerToolInvocation[] = []
    const audits: AgentToolCall[] = []
    const bridge = {
      resolveCredential: vi.fn(async () => 'sk-test-worker'),
      invokeTool: vi.fn(async (input: AgentWorkerToolInvocation) => {
        invocations.push(input)
        return { ok: true, value: [{ id: 'doc-1' }] }
      }),
      recordToolCall: vi.fn(async (call: AgentToolCall) => {
        audits.push(call)
      }),
      requestAuthorization: vi.fn(async () => '仅允许本次调用'),
    }
    harness.run = async (tools) => {
      await tools.search_documents?.execute({ query: 'runtime' }, { toolCallId: 'provider-call-1' })
    }
    const ids = sequenceIds(
      'event-1',
      'event-2',
      'event-3',
      'credential-rpc',
      'turn-1',
      'event-4',
      'call-1',
      'event-5',
      'tool-rpc',
      'event-6',
      'event-7',
      'event-8',
      'event-9',
    )
    const runtime = new AiSdkWorkerRuntime(bridge, ids)
    const events: string[] = []
    runtime.subscribeEvents('run-1', (event) => events.push(event.type))

    const result = await runtime.startRun(request())

    expect(bridge.resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', provider: 'openai' }),
      expect.any(AbortSignal),
    )
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toMatchObject({
      runId: 'run-1',
      internalToolCallId: 'call-1',
      providerToolCallId: 'provider-call-1',
      toolName: 'search_documents',
    })
    expect(audits.map((call) => call.status)).toEqual(['running', 'completed'])
    expect(result.toolCalls).toHaveLength(1)
    expect(result.usage).toMatchObject({ totalTokens: 12, modelTurns: 1 })
    expect(events.filter((type) => type.startsWith('run.') && type !== 'run.progress')).toEqual([
      'run.started',
      'run.completed',
    ])
  })

  it('captures write proposals inside the worker without executing a second registry', async () => {
    const bridge = {
      resolveCredential: vi.fn(async () => 'sk-test-worker'),
      invokeTool: vi.fn(),
      recordToolCall: vi.fn(async () => undefined),
      requestAuthorization: vi.fn(),
    }
    harness.run = async (tools) => {
      await tools.replace_block?.execute(
        { blockId: 'block-1', after: '更新', reason: '测试' },
        { toolCallId: 'provider-write' },
      )
    }
    const runtime = new AiSdkWorkerRuntime(bridge, sequenceIds())
    const result = await runtime.startRun(request())
    const output = JSON.parse(result.output) as {
      outcome: string
      commands: Array<Record<string, unknown>>
    }

    expect(output.outcome).toBe('proposal')
    expect(output.commands).toEqual([
      {
        tool: 'replace_block',
        blockId: 'block-1',
        after: '更新',
        reason: '测试',
      },
    ])
    expect(bridge.invokeTool).not.toHaveBeenCalled()
  })
})

function request(): AgentRunRequestV1 {
  const executionPolicy = {
    version: 1 as const,
    maxToolRounds: 4,
    maxDurationMs: 10_000,
    maxToolFailures: 2,
    tokenBudget: 4_096,
    allowedTools: ['search_documents', 'replace_block'],
    riskLevel: 'propose_write' as const,
    allowUserInput: true,
    allowWriteProposals: true,
    maxRetries: 0,
  }
  return {
    version: 1,
    runId: 'run-1',
    workItemId: 'work-1',
    sessionId: 'session-1',
    objective: '测试 Worker',
    intent: 'default',
    systemInstructions: 'system',
    compiledContext: 'context',
    contextBundle: {
      id: 'bundle-1',
      taskId: 'work-1',
      version: 2,
      scope: { documentId: 'doc-1' },
      permissionSnapshot: {
        actor: 'local_user',
        canReadKnowledge: true,
        canProposeWrites: true,
      },
      sources: [],
      activeRules: [],
      decisions: [],
      conflicts: [],
      compiler: {
        strategy: 'fts5-current-document-v1',
        version: 1,
        query: 'worker',
        tokenBudget: 4_096,
        targetProvider: 'openai',
        targetModel: 'test',
        executionPolicy,
      },
      snapshotHash: 'hash',
      correlationId: 'correlation-1',
      causationId: null,
      createdAt: 1,
    },
    executionPolicy,
    toolManifest: [
      {
        name: 'search_documents',
        description: 'search',
        inputSchema: { type: 'object' },
        risk: 'read',
        executionAuthorization: 'not_required',
        mutationApproval: 'not_required',
        externalActionApproval: 'not_required',
        maxCallsPerRun: 4,
        tags: ['knowledge.read'],
        presentation: { label: 'search', category: 'knowledge' },
        source: { kind: 'builtin' },
      },
      {
        name: 'replace_block',
        description: 'replace',
        inputSchema: { type: 'object' },
        risk: 'write',
        executionAuthorization: 'not_required',
        mutationApproval: 'required',
        externalActionApproval: 'not_required',
        maxCallsPerRun: 4,
        tags: ['document.propose_write'],
        presentation: { label: 'replace', category: 'document' },
        source: { kind: 'builtin' },
      },
    ],
    modelPolicy: {
      provider: 'openai',
      model: 'test',
      endpoint: 'https://example.test/v1',
      temperature: 0,
      topP: 1,
      reasoningEffort: 'auto',
      maxOutputTokens: 1_000,
      credentialRef: { kind: 'provider_secret', provider: 'openai' },
    },
    correlationId: 'correlation-1',
    causationId: null,
  }
}

function sequenceIds(...preferred: string[]): () => string {
  let index = 0
  return () => preferred[index++] ?? `id-${index}`
}
