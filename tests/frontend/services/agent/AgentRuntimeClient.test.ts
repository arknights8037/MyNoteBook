import { describe, expect, it } from 'vitest'

import {
  AgentRuntimeContractError,
  type AgentRunRequestV1,
  type AgentRunResult,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener,
  type AgentRuntimePort,
} from '@/models/agent/agentRuntimeContract'
import { createDefaultExecutionPolicy } from '@/models/agent/executionPolicy'
import { AgentRuntimeClient } from '@/services/agent/AgentRuntimeClient'

describe('AgentRuntimeClient', () => {
  it('claims a run id once and rejects a second adapter drive', async () => {
    const gate = deferred<AgentRunResult>()
    const adapter = new FakeRuntimePort(() => gate.promise)
    const client = new AgentRuntimeClient(adapter)
    const first = client.startRun(request())

    await expect(client.startRun(request())).rejects.toMatchObject<AgentRuntimeContractError>({
      code: 'duplicate_run',
    })
    gate.resolve(result())
    await expect(first).resolves.toEqual(result())
  })

  it('replays ordered buffered events to a late active-run subscriber', async () => {
    const gate = deferred<AgentRunResult>()
    const adapter = new FakeRuntimePort(async (_request, emit) => {
      emit(event(1, 'run.started'))
      emit(event(2, 'message.progress'))
      return gate.promise
    })
    const client = new AgentRuntimeClient(adapter)
    const completion = client.startRun(request())
    const observed: AgentRuntimeEvent[] = []
    const unsubscribe = client.subscribeEvents('run-1', (next) => observed.push(next))

    expect(observed.map((next) => next.sequence)).toEqual([1, 2])
    gate.resolve(result())
    await completion
    unsubscribe()
  })
})

class FakeRuntimePort implements AgentRuntimePort {
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()

  constructor(
    private readonly runner: (
      request: AgentRunRequestV1,
      emit: (event: AgentRuntimeEvent) => void,
    ) => Promise<AgentRunResult>,
  ) {}

  startRun(request: AgentRunRequestV1): Promise<AgentRunResult> {
    return this.runner(request, (next) => {
      for (const listener of this.listeners.get(request.runId) ?? []) listener(next)
    })
  }

  async cancelRun(): Promise<void> {}
  async steerRun(): Promise<void> {}

  subscribeEvents(runId: string, listener: AgentRuntimeEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<AgentRuntimeEventListener>()
    listeners.add(listener)
    this.listeners.set(runId, listeners)
    return () => listeners.delete(listener)
  }
}

function request(): AgentRunRequestV1 {
  const executionPolicy = createDefaultExecutionPolicy({ tokenBudget: 2048, allowedTools: [] })
  return {
    version: 1,
    runId: 'run-1',
    workItemId: 'work-1',
    sessionId: 'conversation-1',
    objective: '测试 Runtime',
    intent: 'answer',
    systemInstructions: 'system',
    compiledContext: 'context',
    contextBundle: {
      id: 'bundle-1',
      taskId: 'work-1',
      version: 2,
      scope: {},
      permissionSnapshot: { actor: 'local_user', canReadKnowledge: true, canProposeWrites: false },
      sources: [],
      activeRules: [],
      decisions: [],
      conflicts: [],
      compiler: {
        strategy: 'fts5-current-document-v1',
        version: 1,
        query: '测试 Runtime',
        tokenBudget: 2048,
        targetProvider: 'openai',
        targetModel: 'test-model',
        executionPolicy,
      },
      snapshotHash: '0'.repeat(64),
      correlationId: 'corr-1',
      causationId: null,
      createdAt: 1,
    },
    executionPolicy,
    toolManifest: [],
    modelPolicy: {
      provider: 'openai',
      model: 'test-model',
      endpoint: 'https://example.com',
      temperature: 0,
      topP: 1,
      reasoningEffort: 'auto',
      maxOutputTokens: 2048,
      credentialRef: { kind: 'provider_secret', provider: 'openai' },
    },
    correlationId: 'corr-1',
    causationId: null,
  }
}

function result(): AgentRunResult {
  return { runId: 'run-1', output: 'done', rounds: 1, toolCalls: [] }
}

function event(sequence: number, type: AgentRuntimeEvent['type']): AgentRuntimeEvent {
  return {
    version: 1,
    eventId: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type,
    occurredAt: sequence,
    correlationId: 'corr-1',
    causationId: null,
    payload: {},
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
