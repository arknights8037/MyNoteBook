import { describe, expect, it, vi } from 'vitest'

import type {
  AgentRunRequestV1,
  AgentRuntimeEvent,
  AgentWorkerMessage,
} from '@/models/agent/agentRuntimeContract'
import { TauriAgentRuntimeAdapter } from '@/infrastructure/runtime/TauriAgentRuntimeAdapter'

describe('TauriAgentRuntimeAdapter', () => {
  it('submits a frozen request to Rust and resolves from Worker events', async () => {
    const bridge = new FakeTauriBridge()
    const adapter = new TauriAgentRuntimeAdapter({
      dataDirectory: 'C:/data',
      recoveryContext: { version: 1 },
      invoke: bridge.invoke,
      listen: bridge.listen,
    })
    const events: AgentRuntimeEvent[] = []
    adapter.subscribeEvents('run-1', (event) => events.push(event))

    const running = adapter.startRun(request('run-1'))
    await settle()
    expect(bridge.invoke).toHaveBeenCalledWith('start_agent_runtime_run', {
      input: {
        dataDirectory: 'C:/data',
        request: request('run-1'),
        recoveryContext: { version: 1 },
      },
    })

    bridge.emit('agent-runtime://event', event('run-1', 'run.started'))
    bridge.emit('agent-runtime://worker-message', {
      version: 1,
      type: 'run.result',
      requestId: 'request-1',
      result: { runId: 'run-1', output: 'done', rounds: 1, toolCalls: [] },
    } satisfies AgentWorkerMessage)

    await expect(running).resolves.toMatchObject({ runId: 'run-1', output: 'done' })
    expect(events.map((item) => item.type)).toEqual(['run.started'])
    await adapter.dispose()
  })

  it('forwards cancel and authorization replies through Rust commands', async () => {
    const bridge = new FakeTauriBridge()
    const requestAuthorizerInput = vi.fn(async () => '允许')
    const adapter = new TauriAgentRuntimeAdapter({
      invoke: bridge.invoke,
      listen: bridge.listen,
      requestAuthorizerInput,
    })
    adapter.subscribeEvents('run-1', () => undefined)
    await settle()

    await adapter.cancelRun('run-1')
    bridge.emit('agent-runtime://authorization-request', {
      version: 1,
      type: 'authorization.request',
      requestId: 'authorization-rpc-1',
      request: {
        authorizationId: 'authorization-1',
        runId: 'run-1',
        question: '允许吗？',
        context: '测试',
        options: ['允许', '拒绝'],
        allowFreeText: false,
      },
    } satisfies AgentWorkerMessage)
    await settle()

    expect(bridge.invoke).toHaveBeenCalledWith('cancel_agent_runtime_run', {
      input: { runId: 'run-1' },
    })
    expect(requestAuthorizerInput).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationId: 'authorization-1' }),
    )
    expect(bridge.invoke).toHaveBeenCalledWith('steer_agent_runtime_run', {
      input: {
        runId: 'run-1',
        input: {
          kind: 'authorization_response',
          authorizationId: 'authorization-1',
          answer: '允许',
        },
      },
    })
    await adapter.dispose()
  })

  it('keeps duplicate-run ownership in the UI client boundary', async () => {
    const bridge = new FakeTauriBridge()
    const adapter = new TauriAgentRuntimeAdapter({ invoke: bridge.invoke, listen: bridge.listen })
    const firstRun = adapter.startRun(request('run-1'))
    await settle()

    await expect(adapter.startRun(request('run-1'))).rejects.toMatchObject({
      code: 'duplicate_run',
    })
    const disposed = expect(firstRun).rejects.toThrow('adapter 已关闭')
    await adapter.dispose()
    await disposed
  })

  it('resumes and acknowledges a terminal retained by Rust Core', async () => {
    const bridge = new FakeTauriBridge()
    bridge.terminal = {
      message: {
        version: 1,
        type: 'run.result',
        requestId: 'request-restored',
        result: { runId: 'run-restored', output: 'retained', rounds: 2, toolCalls: [] },
      },
      recoveryContext: { version: 1 },
    }
    const adapter = new TauriAgentRuntimeAdapter({ invoke: bridge.invoke, listen: bridge.listen })

    await expect(adapter.resumeRun('run-restored')).resolves.toMatchObject({
      runId: 'run-restored',
      output: 'retained',
    })
    expect(bridge.invoke).toHaveBeenCalledWith('get_agent_runtime_terminal', {
      input: { runId: 'run-restored' },
    })

    await adapter.acknowledgeRun('run-restored')
    expect(bridge.invoke).toHaveBeenCalledWith('acknowledge_agent_runtime_terminal', {
      input: { runId: 'run-restored' },
    })
    await adapter.dispose()
  })
})

class FakeTauriBridge {
  private readonly listeners = new Map<string, Set<(event: { payload: unknown }) => void>>()
  terminal: { message: AgentWorkerMessage; recoveryContext: unknown | null } | null = null

  readonly invoke = vi.fn(async <T>(command: string): Promise<T> => {
    if (command === 'get_agent_runtime_terminal') return this.terminal as T
    return undefined as T
  }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>

  readonly listen = async <T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> => {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(handler as (event: { payload: unknown }) => void)
    this.listeners.set(event, listeners)
    return () => listeners.delete(handler as (event: { payload: unknown }) => void)
  }

  emit<T>(event: string, payload: T): void {
    for (const listener of this.listeners.get(event) ?? []) listener({ payload })
  }
}

function event(runId: string, type: AgentRuntimeEvent['type']): AgentRuntimeEvent {
  return {
    version: 1,
    eventId: 'event-1',
    runId,
    sequence: 1,
    type,
    occurredAt: 1,
    correlationId: 'correlation-1',
    causationId: null,
    payload: {},
  }
}

function request(runId: string): AgentRunRequestV1 {
  const executionPolicy = {
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
        executionPolicy,
      },
      snapshotHash: 'hash',
      correlationId: 'correlation-1',
      causationId: null,
      createdAt: 1,
    },
    executionPolicy,
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

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
