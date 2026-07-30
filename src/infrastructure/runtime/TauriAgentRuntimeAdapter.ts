import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import {
  AgentRuntimeContractError,
  type AgentRunRequestV1,
  type AgentRunResult,
  type AgentRunSteerInput,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener,
  type AgentRuntimePort,
  type AgentWorkerAuthorizationRequest,
  type AgentWorkerError,
  type AgentWorkerMessage,
} from '@/models/agent/agentRuntimeContract'

const RUN_EVENT = 'agent-runtime://event'
const MESSAGE_EVENT = 'agent-runtime://worker-message'
const AUTHORIZATION_EVENT = 'agent-runtime://authorization-request'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<UnlistenFn>

export interface TauriAgentRuntimeAdapterDependencies {
  dataDirectory?: string
  invoke?: Invoke
  listen?: Listen
  requestAuthorizerInput?: (request: AgentWorkerAuthorizationRequest) => Promise<string>
}

interface PendingRun {
  resolve: (result: AgentRunResult) => void
  reject: (error: Error) => void
}

/**
 * Phase 3 UI-side Runtime adapter. Rust owns the Worker process and this class
 * only translates Tauri commands/events into the existing Runtime Port.
 */
export class TauriAgentRuntimeAdapter implements AgentRuntimePort {
  private readonly invoke: Invoke
  private readonly listen: Listen
  private readonly claimedRunIds = new Set<string>()
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()
  private readonly pendingRuns = new Map<string, PendingRun>()
  private readonly unlisteners: UnlistenFn[] = []
  private listening: Promise<void> | null = null
  private disposed = false

  constructor(private readonly dependencies: TauriAgentRuntimeAdapterDependencies = {}) {
    this.invoke = dependencies.invoke ?? invoke
    this.listen = dependencies.listen ?? listen
  }

  async startRun(request: AgentRunRequestV1): Promise<AgentRunResult> {
    if (this.claimedRunIds.has(request.runId)) {
      throw new AgentRuntimeContractError(
        'duplicate_run',
        `run_id ${request.runId} 已由 Rust Worker Supervisor 驱动。`,
      )
    }
    this.claimedRunIds.add(request.runId)
    await this.ensureListening()
    const result = new Promise<AgentRunResult>((resolve, reject) => {
      this.pendingRuns.set(request.runId, { resolve, reject })
    })
    try {
      await this.invoke<void>('start_agent_runtime_run', {
        input: {
          dataDirectory: this.dependencies.dataDirectory,
          request,
        },
      })
    } catch (error) {
      this.pendingRuns.delete(request.runId)
      throw normalizeError(error)
    }
    return result
  }

  /** Reattaches a rebuilt WebView to a terminal message retained by Rust Core. */
  async resumeRun(runId: string): Promise<AgentRunResult> {
    if (this.claimedRunIds.has(runId)) {
      throw new AgentRuntimeContractError(
        'duplicate_run',
        `run_id ${runId} 已由当前 Runtime adapter 领取。`,
      )
    }
    this.claimedRunIds.add(runId)
    await this.ensureListening()
    const message = await this.invoke<AgentWorkerMessage | null>('get_agent_runtime_terminal', {
      input: { runId },
    })
    if (!message) {
      throw new AgentRuntimeContractError('run_not_found', `run_id ${runId} 没有待领取终态。`)
    }
    if (message.type === 'run.result') return message.result
    if (message.type === 'run.error') throw workerContractError(message.error)
    throw new Error(`Rust Core 返回了非终态 Worker 消息：${message.type}`)
  }

  /** Acknowledges a terminal only after UI-side Patch/Cognitive persistence succeeds. */
  async acknowledgeRun(runId: string): Promise<void> {
    await this.invoke<void>('acknowledge_agent_runtime_terminal', { input: { runId } })
  }

  async cancelRun(runId: string): Promise<void> {
    await this.invoke<void>('cancel_agent_runtime_run', { input: { runId } })
  }

  async steerRun(runId: string, input: AgentRunSteerInput): Promise<void> {
    await this.invoke<void>('steer_agent_runtime_run', { input: { runId, input } })
  }

  subscribeEvents(runId: string, listener: AgentRuntimeEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<AgentRuntimeEventListener>()
    listeners.add(listener)
    this.listeners.set(runId, listeners)
    void this.ensureListening()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(runId)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.listening?.catch(() => undefined)
    for (const unlisten of this.unlisteners.splice(0)) unlisten()
    for (const pending of this.pendingRuns.values()) {
      pending.reject(new Error('Rust Worker Runtime adapter 已关闭。'))
    }
    this.pendingRuns.clear()
    this.listeners.clear()
  }

  private ensureListening(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Runtime adapter 已关闭。'))
    return (this.listening ??= this.registerListeners())
  }

  private async registerListeners(): Promise<void> {
    const unlisteners = await Promise.all([
      this.listen<AgentRuntimeEvent>(RUN_EVENT, ({ payload }) => this.publish(payload)),
      this.listen<AgentWorkerMessage>(MESSAGE_EVENT, ({ payload }) => this.handleMessage(payload)),
      this.listen<Extract<AgentWorkerMessage, { type: 'authorization.request' }>>(
        AUTHORIZATION_EVENT,
        ({ payload }) => void this.handleAuthorization(payload),
      ),
    ])
    if (this.disposed) {
      for (const unlisten of unlisteners) unlisten()
      return
    }
    this.unlisteners.push(...unlisteners)
  }

  private publish(event: AgentRuntimeEvent): void {
    if (event.version !== 1 || typeof event.runId !== 'string') return
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event)
  }

  private handleMessage(message: AgentWorkerMessage): void {
    if (message.version !== 1) return
    if (message.type === 'run.result') {
      const pending = this.pendingRuns.get(message.result.runId)
      if (!pending) return
      this.pendingRuns.delete(message.result.runId)
      pending.resolve(message.result)
      return
    }
    if (message.type === 'run.error') {
      const pending = this.pendingRuns.get(message.runId)
      if (!pending) return
      this.pendingRuns.delete(message.runId)
      pending.reject(workerContractError(message.error))
    }
  }

  private async handleAuthorization(
    message: Extract<AgentWorkerMessage, { type: 'authorization.request' }>,
  ): Promise<void> {
    const request = message.request
    try {
      if (!this.dependencies.requestAuthorizerInput) {
        throw new AgentRuntimeContractError(
          'authorization_not_found',
          'UI 未提供 Worker 授权输入通道。',
        )
      }
      const answer = await this.dependencies.requestAuthorizerInput(request)
      await this.steerRun(request.runId, {
        kind: 'authorization_response',
        authorizationId: request.authorizationId,
        answer,
      })
    } catch (error) {
      const pending = this.pendingRuns.get(request.runId)
      if (pending) {
        this.pendingRuns.delete(request.runId)
        pending.reject(normalizeError(error))
      }
    }
  }
}

function workerContractError(error: AgentWorkerError): Error {
  if (
    error.code === 'duplicate_run' ||
    error.code === 'run_not_found' ||
    error.code === 'invalid_steer' ||
    error.code === 'authorization_not_found'
  ) {
    return new AgentRuntimeContractError(error.code, error.message)
  }
  return new Error(error.message)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
