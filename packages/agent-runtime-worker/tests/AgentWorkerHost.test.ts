import { describe, expect, it, vi } from 'vitest'

import type {
  AgentRunRequestV1,
  AgentRunResult,
  AgentRuntimeEvent,
  AgentRuntimeEventListener,
  AgentRuntimePort,
  AgentWorkerHostMessage,
  AgentWorkerMessage,
} from '@mynotebook/agent-runtime-contracts'

import {
  AgentWorkerHost,
  type AgentWorkerChannel,
  type AgentWorkerRuntimeBridge,
} from '../src/AgentWorkerHost.js'

describe('AgentWorkerHost', () => {
  it('announces identity, forwards ordered events, and returns one run result', async () => {
    const channel = new MemoryChannel()
    const runtime = new FakeRuntime()
    const host = new AgentWorkerHost({
      channel,
      createRuntime: () => runtime,
      createId: sequenceIds('worker', 'event'),
      now: () => 42,
      heartbeatIntervalMs: 60_000,
      runtimeVersion: 'test',
    })

    host.start()
    expect(channel.sent[0]).toMatchObject({
      type: 'runtime.hello',
      identity: { workerInstanceId: 'worker', runtime: 'ai-sdk', runtimeVersion: 'test' },
    })
    expect(channel.sent[1]).toMatchObject({ type: 'heartbeat', occurredAt: 42 })

    channel.receive({
      version: 1,
      type: 'run.start',
      requestId: 'request-1',
      request: request('run-1'),
    })
    await settle()

    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        type: 'run.event',
        event: expect.objectContaining({ runId: 'run-1', type: 'run.started' }),
      }),
    )
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        type: 'run.result',
        requestId: 'request-1',
        result: expect.objectContaining({ runId: 'run-1', output: 'done' }),
      }),
    )
    expect(channel.sent.filter((message) => message.type === 'run.result')).toHaveLength(1)

    channel.receive({
      version: 1,
      type: 'run.start',
      requestId: 'request-2',
      request: request('run-1'),
    })
    expect(channel.sent.at(-1)).toMatchObject({
      type: 'run.error',
      requestId: 'request-2',
      error: { code: 'duplicate_run' },
    })

    await host.stop('test complete')
  })

  it('routes tool and authorization RPC replies through the Rust host boundary', async () => {
    const channel = new MemoryChannel()
    let bridge!: AgentWorkerRuntimeBridge
    const host = new AgentWorkerHost({
      channel,
      createRuntime: (value) => {
        bridge = value
        return new FakeRuntime()
      },
      createId: sequenceIds('worker', 'authorization-rpc'),
      heartbeatIntervalMs: 60_000,
    })
    host.start()

    const toolPromise = bridge.invokeTool({
      requestId: 'tool-rpc',
      runId: 'run-1',
      turnId: 'turn-1',
      internalToolCallId: 'call-1',
      providerToolCallId: 'provider-1',
      toolName: 'search_documents',
      arguments: { query: 'worker' },
      source: { kind: 'builtin' },
    })
    expect(channel.sent.at(-1)).toMatchObject({ type: 'tool.invoke' })
    channel.receive({
      version: 1,
      type: 'tool.result',
      requestId: 'tool-rpc',
      result: { ok: true, value: [{ id: 'doc' }] },
    })
    await expect(toolPromise).resolves.toEqual({ ok: true, value: [{ id: 'doc' }] })

    const authorizationPromise = bridge.requestAuthorization({
      authorizationId: 'authorization-1',
      runId: 'run-1',
      question: '允许吗？',
      context: '测试',
      options: ['允许', '拒绝'],
      allowFreeText: false,
    })
    expect(channel.sent.at(-1)).toMatchObject({
      type: 'authorization.request',
      requestId: 'authorization-rpc',
    })
    channel.receive({
      version: 1,
      type: 'authorization.result',
      requestId: 'authorization-rpc',
      authorizationId: 'authorization-1',
      answer: '允许',
    })
    await expect(authorizationPromise).resolves.toBe('允许')

    const credentialPromise = bridge.resolveCredential({
      requestId: 'credential-rpc',
      runId: 'run-1',
      provider: 'openai',
    })
    expect(channel.sent.at(-1)).toMatchObject({ type: 'credential.request' })
    channel.receive({
      version: 1,
      type: 'credential.result',
      requestId: 'credential-rpc',
      credential: 'sk-test',
    })
    await expect(credentialPromise).resolves.toBe('sk-test')

    const recordPromise = bridge.recordToolCall({
      id: 'call-1',
      taskId: 'work-1',
      runId: 'run-1',
      turnId: 'turn-1',
      providerToolCallId: null,
      toolName: 'search_documents',
      argumentsJson: '{}',
      resultJson: null,
      status: 'running',
      startedAt: 1,
      completedAt: null,
      error: null,
    })
    const recordMessage = channel.sent.at(-1)
    expect(recordMessage).toMatchObject({ type: 'tool.record' })
    const recordRequestId =
      recordMessage?.type === 'tool.record' ? recordMessage.requestId : 'missing'
    channel.receive({ version: 1, type: 'tool.recorded', requestId: recordRequestId })
    await expect(recordPromise).resolves.toBeUndefined()

    await host.stop('test complete')
  })

  it('rejects a duplicate active run and acknowledges cancel and steer commands', async () => {
    const channel = new MemoryChannel()
    const runtime = new FakeRuntime(true)
    const host = new AgentWorkerHost({
      channel,
      createRuntime: () => runtime,
      createId: sequenceIds('worker'),
      heartbeatIntervalMs: 60_000,
    })
    host.start()
    const start = {
      version: 1 as const,
      type: 'run.start' as const,
      requestId: 'request-1',
      request: request('run-1'),
    }
    channel.receive(start)
    channel.receive({ ...start, requestId: 'request-2' })
    channel.receive({ version: 1, type: 'run.cancel', requestId: 'cancel-1', runId: 'run-1' })
    channel.receive({
      version: 1,
      type: 'run.steer',
      requestId: 'steer-1',
      runId: 'run-1',
      input: {
        kind: 'authorization_response',
        authorizationId: 'authorization-1',
        answer: '允许',
      },
    })
    await settle()

    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        requestId: 'request-2',
        error: expect.objectContaining({ code: 'duplicate_run' }),
      }),
    )
    expect(runtime.cancelRun).toHaveBeenCalledWith('run-1')
    expect(runtime.steerRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ authorizationId: 'authorization-1' }),
    )
    expect(channel.sent).toContainEqual(
      expect.objectContaining({ type: 'run.cancelled', requestId: 'cancel-1' }),
    )
    expect(channel.sent).toContainEqual(
      expect.objectContaining({ type: 'run.steered', requestId: 'steer-1' }),
    )

    runtime.finish()
    await host.stop('test complete')
  })
})

class MemoryChannel implements AgentWorkerChannel {
  readonly sent: AgentWorkerMessage[] = []
  private readonly listeners = new Set<(message: AgentWorkerHostMessage) => void>()

  send(message: AgentWorkerMessage): void {
    this.sent.push(message)
  }

  subscribe(listener: (message: AgentWorkerHostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  receive(message: AgentWorkerHostMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

class FakeRuntime implements AgentRuntimePort {
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()
  private finishRun: (() => void) | null = null

  readonly cancelRun = vi.fn(async () => undefined)
  readonly steerRun = vi.fn(async () => undefined)

  constructor(private readonly wait = false) {}

  async startRun(input: AgentRunRequestV1): Promise<AgentRunResult> {
    this.emit({
      version: 1,
      eventId: 'event-1',
      runId: input.runId,
      sequence: 1,
      type: 'run.started',
      occurredAt: 1,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: {},
    })
    if (this.wait) await new Promise<void>((resolve) => (this.finishRun = resolve))
    return { runId: input.runId, output: 'done', rounds: 1, toolCalls: [] }
  }

  finish(): void {
    this.finishRun?.()
  }

  subscribeEvents(runId: string, listener: AgentRuntimeEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(runId, listeners)
    return () => listeners.delete(listener)
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event)
  }
}

function request(runId: string): AgentRunRequestV1 {
  return {
    version: 1,
    runId,
    workItemId: 'work-1',
    sessionId: 'session-1',
    objective: 'test',
    intent: 'default',
    systemInstructions: 'system',
    compiledContext: 'context',
    contextBundle: {
      id: 'bundle-1',
      taskId: 'work-1',
      version: 2,
      scope: {},
      permissionSnapshot: {
        actor: 'local_user',
        canReadKnowledge: true,
        canProposeWrites: false,
      },
      sources: [],
      activeRules: [],
      decisions: [],
      conflicts: [],
      compiler: {
        strategy: 'fts5-current-document-v1',
        version: 1,
        query: 'test',
        tokenBudget: 100,
        targetProvider: 'openai',
        targetModel: 'test',
        executionPolicy: policy(),
      },
      snapshotHash: 'hash',
      correlationId: 'correlation-1',
      causationId: null,
      createdAt: 1,
    },
    executionPolicy: policy(),
    toolManifest: [],
    modelPolicy: {
      provider: 'openai',
      model: 'test',
      endpoint: 'https://example.test/v1',
      temperature: 0,
      topP: 1,
      reasoningEffort: 'auto',
      maxOutputTokens: 100,
      credentialRef: { kind: 'provider_secret', provider: 'openai' },
    },
    correlationId: 'correlation-1',
    causationId: null,
  }
}

function policy() {
  return {
    version: 1 as const,
    maxToolRounds: 1,
    maxDurationMs: 10_000,
    maxToolFailures: 1,
    tokenBudget: 100,
    allowedTools: [],
    riskLevel: 'read_only' as const,
    allowUserInput: false,
    allowWriteProposals: false,
    maxRetries: 0,
  }
}

function sequenceIds(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? `id-${index}`
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
