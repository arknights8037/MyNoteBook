import type {
  AgentRunRequestV1,
  AgentRuntimeEvent,
  DomainToolManifestEntry,
} from '@mynotebook/agent-runtime-contracts'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'

import { PiAgentRuntimePrototype } from '../src/PiAgentRuntimePrototype.js'
import type { PiToolRpcInvocation, PiToolRpcPort } from '../src/types.js'

describe('PiAgentRuntimePrototype vertical slice', () => {
  it('runs search -> read -> read-only MCP -> Patch capture with independent IDs and ordered events', async () => {
    const faux = createFauxCore({ provider: 'prototype', tokensPerSecond: 10_000 })
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('search_documents', { query: 'runtime', limit: 5 }, { id: 'provider-search' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('read_document', { documentId: 'doc-1' }, { id: 'provider-read' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('mcp__trusted__lookup', { query: 'PI' }, { id: 'provider-mcp' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          'submit_document_edits',
          {
            summary: '更新运行时说明',
            documents: [
              {
                documentId: 'doc-1',
                edits: [
                  {
                    kind: 'replace',
                    targetBlockIds: ['block-1'],
                    content: 'PI 原型内容',
                    reason: '保持文档与实现一致',
                  },
                ],
              },
            ],
          },
          { id: 'provider-submit' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([
        fauxThinking('仅保存 Provider 明确返回的 reasoning。'),
        { type: 'text', text: '已生成修改提案。' },
      ]),
    ])
    const invocations: PiToolRpcInvocation[] = []
    const rpc: PiToolRpcPort = {
      invoke: vi.fn(async (request, options) => {
        invocations.push(request)
        options.onProgress({ message: `${request.toolName} 处理中` })
        if (request.toolName === 'search_documents') {
          return { ok: true, value: [{ id: 'doc-1', title: 'Runtime' }] }
        }
        if (request.toolName === 'read_document') {
          return { ok: true, value: { id: 'doc-1', revision: 7, blocks: ['block-1'] } }
        }
        return { ok: true, value: { content: [{ type: 'text', text: 'PI' }], isError: false } }
      }),
    }
    const events: AgentRuntimeEvent[] = []
    let id = 0
    const runtime = new PiAgentRuntimePrototype({
      toolRpc: rpc,
      resolveModelDriver: () => ({
        model: faux.getModel(),
        streamFn: faux.streamSimple as unknown as StreamFn,
      }),
      resolveCredential: async () => 'resolved-outside-request',
      createId: () => `internal-${++id}`,
      now: () => 1_700_000_000_000 + id,
    })
    runtime.subscribeEvents('run-pi', (event) => events.push(event))

    const result = await runtime.startRun(createRequest())

    expect(invocations.map((call) => call.toolName)).toEqual([
      'search_documents',
      'read_document',
      'mcp__trusted__lookup',
    ])
    expect(invocations.every((call) => call.internalToolCallId !== call.providerToolCallId)).toBe(
      true,
    )
    expect(invocations[2]?.source).toMatchObject({
      kind: 'mcp',
      serverTrusted: true,
      readOnly: true,
    })
    expect(result.output).toBe('已生成修改提案。')
    expect(result.rounds).toBe(5)
    expect(result.patchProposals).toEqual([
      {
        documentId: 'doc-1',
        operation: 'replace',
        blockId: 'block-1',
        targetBlockIds: ['block-1'],
        after: 'PI 原型内容',
        reason: '保持文档与实现一致',
      },
    ])
    expect(result.toolCalls.map((call) => call.providerToolCallId)).toEqual([
      'provider-search',
      'provider-read',
      'provider-mcp',
      'provider-submit',
    ])
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(events.some((event) => event.type === 'tool.progress')).toBe(true)
    expect(
      events.some(
        (event) => event.type === 'message.progress' && event.payload.channel === 'reasoning',
      ),
    ).toBe(true)
    expect(result.usage).toMatchObject({ modelTurns: 5 })
    expect(result.finishReason).toBe('stop')
    expect(
      events.filter((event) => event.type.startsWith('run.') && isTerminal(event)),
    ).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('preserves MCP isError as a failed tool call instead of a successful opaque value', async () => {
    const faux = createFauxCore({ provider: 'prototype-error', tokensPerSecond: 10_000 })
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('mcp__trusted__lookup', { query: 'denied' }, { id: 'provider-error' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('外部工具失败，未使用其结果。'),
    ])
    const runtime = createRuntime(faux, {
      invoke: async () => ({ ok: true, isError: true, error: 'MCP business failure' }),
    })

    const result = await runtime.startRun(
      createRequest({
        executionPolicy: { ...createRequest().executionPolicy, allowedTools: ['mcp:*'] },
        toolManifest: [mcpManifest()],
      }),
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({
      providerToolCallId: 'provider-error',
      status: 'failed',
      error: 'MCP business failure',
    })
  })

  it('persists the running audit before invoking the Rust tool RPC', async () => {
    const faux = createFauxCore({ provider: 'prototype-audit', tokensPerSecond: 10_000 })
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('search_documents', { query: 'audit', limit: 1 }, { id: 'provider-audit' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('审计顺序正确。'),
    ])
    let releaseAudit!: () => void
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve
    })
    let markAuditStarted!: () => void
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve
    })
    const rpc = vi.fn(async () => ({ ok: true, value: [] }))
    let id = 0
    const runtime = new PiAgentRuntimePrototype({
      toolRpc: { invoke: rpc },
      resolveModelDriver: () => ({
        model: faux.getModel(),
        streamFn: faux.streamSimple as unknown as StreamFn,
      }),
      resolveCredential: async () => 'secret',
      createId: () => `internal-${++id}`,
      recordToolCall: async (call) => {
        if (call.status === 'running') {
          markAuditStarted()
          await auditGate
        }
      },
    })

    const run = runtime.startRun(
      createRequest({
        executionPolicy: {
          ...createRequest().executionPolicy,
          allowedTools: ['search_documents'],
        },
        toolManifest: [builtinManifest('search_documents')],
      }),
    )
    await auditStarted
    expect(rpc).not.toHaveBeenCalled()
    releaseAudit()

    await expect(run).resolves.toMatchObject({ output: '审计顺序正确。' })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('executes independent PI tool calls in parallel and keeps provider/internal identities separate', async () => {
    const faux = createFauxCore({ provider: 'prototype-parallel', tokensPerSecond: 10_000 })
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('search_documents', { query: 'a', limit: 2 }, { id: 'provider-a' }),
          fauxToolCall('read_document', { documentId: 'doc-1' }, { id: 'provider-b' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('并行读取完成。'),
    ])
    let active = 0
    let maximum = 0
    const runtime = createRuntime(faux, {
      invoke: async (request) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) =>
          setTimeout(resolve, request.toolName === 'search_documents' ? 20 : 5),
        )
        active -= 1
        return { ok: true, value: request.toolName }
      },
    })

    const result = await runtime.startRun(
      createRequest({
        executionPolicy: {
          ...createRequest().executionPolicy,
          allowedTools: ['search_documents', 'read_document'],
        },
        toolManifest: [builtinManifest('search_documents'), builtinManifest('read_document')],
      }),
    )

    expect(maximum).toBe(2)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls.every((call) => call.id !== call.providerToolCallId)).toBe(true)
  })

  it('cancels an in-flight RPC, waits for its terminal audit, and emits one cancelled terminal', async () => {
    const faux = createFauxCore({ provider: 'prototype-cancel', tokensPerSecond: 10_000 })
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('search_documents', { query: 'wait', limit: 1 }, { id: 'provider-wait' }),
        { stopReason: 'toolUse' },
      ),
    ])
    let invocationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      invocationStarted = resolve
    })
    const events: AgentRuntimeEvent[] = []
    const runtime = createRuntime(faux, {
      invoke: async (_request, options) => {
        invocationStarted()
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        })
        return { ok: true }
      },
    })
    runtime.subscribeEvents('run-pi', (event) => events.push(event))
    const run = runtime.startRun(
      createRequest({
        executionPolicy: { ...createRequest().executionPolicy, allowedTools: ['search_documents'] },
        toolManifest: [builtinManifest('search_documents')],
      }),
    )
    await started

    await runtime.cancelRun('run-pi')
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })

    expect(events.some((event) => event.type === 'tool.cancelled')).toBe(true)
    expect(
      events
        .filter((event) => event.type.startsWith('run.') && isTerminal(event))
        .map((event) => event.type),
    ).toEqual(['run.cancelled'])
  })

  it('rejects a duplicate run id with the shared typed contract error', async () => {
    const faux = createFauxCore({ provider: 'prototype-duplicate', tokensPerSecond: 10_000 })
    faux.setResponses([fauxAssistantMessage('done')])
    const runtime = createRuntime(faux, { invoke: async () => ({ ok: true }) })

    await runtime.startRun(createRequest())
    await expect(runtime.startRun(createRequest())).rejects.toMatchObject({ code: 'duplicate_run' })
  })

  it('resolves a serializable output descriptor through the local validator registry', async () => {
    const faux = createFauxCore({ provider: 'prototype-structured', tokensPerSecond: 10_000 })
    faux.setResponses([fauxAssistantMessage('{"answer":"validated"}')])
    const runtime = new PiAgentRuntimePrototype({
      toolRpc: { invoke: async () => ({ ok: true }) },
      resolveModelDriver: () => ({
        model: faux.getModel(),
        streamFn: faux.streamSimple as unknown as StreamFn,
      }),
      resolveCredential: async () => 'secret',
      outputValidators: {
        resolve: (descriptor) =>
          descriptor.id === 'prototype.answer' && descriptor.version === 1
            ? (value) => {
                if (!value || typeof value !== 'object' || !('answer' in value))
                  throw new Error('invalid')
                return value
              }
            : null,
      },
    })

    const result = await runtime.startRun(
      createRequest({
        outputContract: {
          id: 'prototype.answer',
          version: 1,
          jsonSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
          systemInstruction: '返回 answer。',
        },
      }),
    )

    expect(result.structuredOutput).toEqual({ answer: 'validated' })
  })
})

function createRuntime(
  faux: ReturnType<typeof createFauxCore>,
  toolRpc: PiToolRpcPort,
): PiAgentRuntimePrototype {
  let id = 0
  return new PiAgentRuntimePrototype({
    toolRpc,
    resolveModelDriver: () => ({
      model: faux.getModel(),
      streamFn: faux.streamSimple as unknown as StreamFn,
    }),
    resolveCredential: async () => 'secret',
    createId: () => `internal-${++id}`,
  })
}

function createRequest(overrides: Partial<AgentRunRequestV1> = {}): AgentRunRequestV1 {
  const toolManifest = [
    builtinManifest('search_documents'),
    builtinManifest('read_document'),
    mcpManifest(),
    builtinManifest('submit_document_edits', 'write'),
  ]
  return {
    version: 1,
    runId: 'run-pi',
    workItemId: 'task-pi',
    sessionId: 'conversation-pi',
    objective: '查找并更新运行时文档',
    intent: 'default',
    systemInstructions: '只使用给定工具。',
    compiledContext: 'Context Bundle snapshot',
    contextBundle: {
      id: 'bundle-pi',
      taskId: 'task-pi',
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
        query: 'runtime',
        tokenBudget: 2048,
        targetProvider: 'openai-compatible',
        targetModel: 'prototype',
        executionPolicy: basePolicy(toolManifest.map((tool) => tool.name)),
      },
      snapshotHash: 'sha256:prototype',
      correlationId: 'correlation-pi',
      causationId: null,
      createdAt: 1_700_000_000_000,
    },
    executionPolicy: basePolicy([...toolManifest.map((tool) => tool.name), 'mcp:*']),
    toolManifest,
    modelPolicy: {
      provider: 'openai-compatible',
      model: 'prototype',
      endpoint: 'http://127.0.0.1.invalid/v1',
      temperature: 0,
      topP: 1,
      reasoningEffort: 'medium',
      maxOutputTokens: 2048,
      credentialRef: { kind: 'provider_secret', provider: 'openai-compatible' },
    },
    correlationId: 'correlation-pi',
    causationId: null,
    ...overrides,
  }
}

function basePolicy(allowedTools: string[]): AgentRunRequestV1['executionPolicy'] {
  return {
    version: 1,
    maxToolRounds: 12,
    maxDurationMs: 30_000,
    maxToolFailures: 3,
    tokenBudget: 2048,
    allowedTools,
    riskLevel: 'propose_write',
    allowUserInput: false,
    allowWriteProposals: true,
    maxRetries: 0,
    budget: {
      maxInputTokens: null,
      maxOutputTokens: 2048,
      maxTotalTokens: null,
      maxCostUsdMicros: null,
      maxModelTurns: 12,
      maxParallelTools: null,
    },
  }
}

function builtinManifest(
  name: string,
  risk: DomainToolManifestEntry['risk'] = 'read',
): DomainToolManifestEntry {
  const inputSchema =
    name === 'submit_document_edits'
      ? {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            documents: { type: 'array', items: { type: 'object' } },
          },
          required: ['summary', 'documents'],
        }
      : { type: 'object', additionalProperties: true }
  return {
    name,
    description: `${name} prototype`,
    inputSchema,
    risk,
    executionAuthorization: 'not_required',
    mutationApproval: risk === 'write' ? 'required' : 'not_required',
    externalActionApproval: 'not_required',
    maxCallsPerRun: 4,
    tags: risk === 'write' ? ['document.propose_write'] : ['document.read'],
    presentation: { label: name, category: 'document' },
    source: { kind: 'builtin' },
  }
}

function mcpManifest(): DomainToolManifestEntry {
  return {
    name: 'mcp__trusted__lookup',
    description: 'read-only MCP prototype',
    inputSchema: { type: 'object', additionalProperties: true },
    risk: 'read',
    executionAuthorization: 'not_required',
    mutationApproval: 'not_required',
    externalActionApproval: 'not_required',
    maxCallsPerRun: 4,
    tags: ['external.read'],
    presentation: { label: 'MCP lookup', category: 'external' },
    source: {
      kind: 'mcp',
      serverId: 'trusted',
      serverName: 'Trusted',
      toolName: 'lookup',
      readOnly: true,
      serverTrusted: true,
    },
  }
}

function isTerminal(event: AgentRuntimeEvent): boolean {
  return (
    event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled'
  )
}
