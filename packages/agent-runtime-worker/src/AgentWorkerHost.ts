import type {
  AgentRunRequestV1,
  AgentSidecarSubmissionV1,
  AgentRunSteerInput,
  AgentRuntimePort,
  AgentWorkerAuthorizationRequest,
  AgentWorkerError,
  AgentWorkerHostMessage,
  AgentWorkerIdentity,
  AgentWorkerMessage,
  AgentWorkerProviderRequest,
  AgentWorkerToolInvocation,
  AgentWorkerToolResult,
  AgentToolCall,
} from '@mynotebook/agent-runtime-contracts'

import { planSidecarRun } from './SidecarRunPlanner.js'

const AGENT_WORKER_PROTOCOL_VERSION = 1 as const

export interface AgentWorkerChannel {
  send(message: AgentWorkerMessage): void
  subscribe(listener: (message: AgentWorkerHostMessage) => void): () => void
  close?(): void
}

export interface AgentWorkerRuntimeBridge {
  invokeTool(
    request: AgentWorkerToolInvocation,
    signal?: AbortSignal,
  ): Promise<AgentWorkerToolResult>
  requestAuthorization(
    request: AgentWorkerAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<string>
  recordToolCall(call: AgentToolCall, signal?: AbortSignal): Promise<void>
  proxyProviderFetch(
    runId: string,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response>
}

export interface AgentWorkerHostOptions {
  channel: AgentWorkerChannel
  createRuntime: (bridge: AgentWorkerRuntimeBridge) => AgentRuntimePort
  createId?: () => string
  now?: () => number
  heartbeatIntervalMs?: number
  runtimeVersion?: string
}

interface PendingHostReply<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  abortCleanup: () => void
}

interface PendingProviderResponse {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  stream: ReadableStream<Uint8Array>
  controller: ReadableStreamDefaultController<Uint8Array>
  responseStarted: boolean
  finished: boolean
  abortCleanup: () => void
}

/**
 * Owns one Runtime adapter inside the Node Worker. The host is deliberately
 * independent from AI SDK so process/RPC behavior can be tested before the
 * production adapter is moved out of the WebView.
 */
export class AgentWorkerHost {
  readonly identity: AgentWorkerIdentity

  private readonly runtime: AgentRuntimePort
  private readonly claimedRunIds = new Set<string>()
  private readonly terminalRunIds = new Set<string>()
  private readonly activeRunIds = new Set<string>()
  private readonly activeRunPromises = new Map<string, Promise<void>>()
  private readonly pendingTools = new Map<string, PendingHostReply<AgentWorkerToolResult>>()
  private readonly pendingAuthorizations = new Map<string, PendingHostReply<string>>()
  private readonly pendingToolRecords = new Map<string, PendingHostReply<void>>()
  private readonly pendingProviderResponses = new Map<string, PendingProviderResponse>()
  private readonly createId: () => string
  private readonly now: () => number
  private readonly heartbeatIntervalMs: number
  private unsubscribe: (() => void) | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false

  constructor(private readonly options: AgentWorkerHostOptions) {
    this.createId = options.createId ?? defaultCreateId
    this.now = options.now ?? Date.now
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    this.identity = {
      protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
      workerInstanceId: this.createId(),
      pid: process.pid,
      runtime: 'ai-sdk',
      runtimeVersion: options.runtimeVersion ?? 'phase3-foundation',
    }
    this.runtime = options.createRuntime({
      invokeTool: (request, signal) => this.invokeTool(request, signal),
      requestAuthorization: (request, signal) => this.requestAuthorization(request, signal),
      recordToolCall: (call, signal) => this.recordToolCall(call, signal),
      proxyProviderFetch: (runId, input, init) => this.proxyProviderFetch(runId, input, init),
    })
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.options.channel.subscribe((message) => this.onMessage(message))
    this.send({
      version: AGENT_WORKER_PROTOCOL_VERSION,
      type: 'runtime.hello',
      identity: this.identity,
    })
    this.emitHeartbeat()
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  async stop(reason = 'Worker host stopped.'): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    await Promise.allSettled([...this.activeRunIds].map((runId) => this.runtime.cancelRun(runId)))
    await Promise.allSettled(this.activeRunPromises.values())
    this.rejectPending(reason)
    this.send({
      version: AGENT_WORKER_PROTOCOL_VERSION,
      type: 'shutdown',
      workerInstanceId: this.identity.workerInstanceId,
      reason,
    })
    this.unsubscribe?.()
    this.unsubscribe = null
    this.options.channel.close?.()
  }

  private onMessage(message: AgentWorkerHostMessage): void {
    if (message.version !== AGENT_WORKER_PROTOCOL_VERSION || this.stopping) return
    switch (message.type) {
      case 'runtime.hello':
        if (message.protocolVersion !== AGENT_WORKER_PROTOCOL_VERSION) {
          void this.stop(`Unsupported supervisor protocol ${message.protocolVersion}.`)
        }
        return
      case 'run.start':
        this.startRun(message.requestId, message.request)
        return
      case 'orchestration.start':
        void this.startOrchestration(message.requestId, message.submission)
        return
      case 'run.cancel':
        void this.cancelRun(message.requestId, message.runId)
        return
      case 'run.steer':
        void this.steerRun(message.requestId, message.runId, message.input)
        return
      case 'tool.result':
        this.resolvePending(this.pendingTools, message.requestId, message.result)
        return
      case 'authorization.result':
        this.resolvePending(this.pendingAuthorizations, message.requestId, message.answer)
        return
      case 'tool.recorded':
        this.resolvePending(this.pendingToolRecords, message.requestId, undefined)
        return
      case 'provider.response.started':
        this.startProviderResponse(message.requestId, message.status, message.headers)
        return
      case 'provider.response.chunk':
        this.pushProviderChunk(message.requestId, message.bodyBase64)
        return
      case 'provider.response.completed':
        this.finishProviderResponse(message.requestId)
        return
      case 'provider.response.failed':
        this.failProviderResponse(message.requestId, new Error(message.error))
        return
      case 'shutdown':
        void this.stop(message.reason)
    }
  }

  private startRun(requestId: string, request: AgentRunRequestV1): void {
    if (this.claimedRunIds.has(request.runId)) {
      this.sendRunError(requestId, request.runId, {
        code: 'duplicate_run',
        message: `run_id ${request.runId} 已由 Worker 驱动。`,
        retryable: false,
      })
      return
    }
    this.claimedRunIds.add(request.runId)
    const unsubscribe = this.runtime.subscribeEvents(request.runId, (event) => {
      if (this.terminalRunIds.has(request.runId)) return
      if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
      ) {
        this.terminalRunIds.add(request.runId)
      }
      this.send({ version: AGENT_WORKER_PROTOCOL_VERSION, type: 'run.event', event })
    })
    this.activeRunIds.add(request.runId)
    const running = this.runtime
      .startRun(request)
      .then((result) => {
        this.send({ version: AGENT_WORKER_PROTOCOL_VERSION, type: 'run.result', requestId, result })
      })
      .catch((error: unknown) => {
        this.sendRunError(requestId, request.runId, normalizeWorkerError(error))
      })
      .finally(() => {
        unsubscribe()
        this.activeRunIds.delete(request.runId)
        this.activeRunPromises.delete(request.runId)
      })
    this.activeRunPromises.set(request.runId, running)
  }

  private async startOrchestration(
    requestId: string,
    submission: AgentSidecarSubmissionV1,
  ): Promise<void> {
    try {
      const planned = await planSidecarRun(submission)
      this.send({
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: 'orchestration.prepared',
        requestId,
        task: {
          id: planned.task.id,
          runId: planned.task.runId,
          workflowId: planned.task.workflowId,
          sessionId: planned.task.sessionId,
          documentId: planned.task.documentId,
          projectId: planned.task.projectId,
          conversationId: planned.task.conversationId,
          status: planned.task.status,
          userInstruction: planned.task.userInstruction,
          contextScope: planned.task.contextScope,
          model: planned.task.model,
          currentStep: planned.task.currentStep,
          createdAt: planned.task.createdAt,
          correlationId: planned.task.correlationId,
          causationId: planned.task.causationId,
          executionPolicy: planned.task.executionPolicy,
          contextBundleId: planned.task.contextBundleId,
          provider: planned.task.provider,
        },
        request: planned.request,
      })
      this.startRun(requestId, planned.request)
    } catch (error) {
      this.sendRunError(requestId, submission.runId, normalizeWorkerError(error))
    }
  }

  private async cancelRun(requestId: string, runId: string): Promise<void> {
    try {
      await this.runtime.cancelRun(runId)
      this.send({ version: AGENT_WORKER_PROTOCOL_VERSION, type: 'run.cancelled', requestId, runId })
    } catch (error) {
      this.sendRunError(requestId, runId, normalizeWorkerError(error))
    }
  }

  private async steerRun(
    requestId: string,
    runId: string,
    input: AgentRunSteerInput,
  ): Promise<void> {
    try {
      await this.runtime.steerRun(runId, input)
      this.send({ version: AGENT_WORKER_PROTOCOL_VERSION, type: 'run.steered', requestId, runId })
    } catch (error) {
      this.sendRunError(requestId, runId, normalizeWorkerError(error))
    }
  }

  private invokeTool(
    request: AgentWorkerToolInvocation,
    signal?: AbortSignal,
  ): Promise<AgentWorkerToolResult> {
    return this.waitForHostReply(
      this.pendingTools,
      request.requestId,
      signal,
      () => {
        this.send({ version: AGENT_WORKER_PROTOCOL_VERSION, type: 'tool.invoke', request })
      },
      () => {
        this.send({
          version: AGENT_WORKER_PROTOCOL_VERSION,
          type: 'tool.cancel',
          internalToolCallId: request.internalToolCallId,
        })
      },
    )
  }

  private requestAuthorization(
    request: AgentWorkerAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const requestId = this.createId()
    return this.waitForHostReply(this.pendingAuthorizations, requestId, signal, () => {
      this.send({
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: 'authorization.request',
        requestId,
        request,
      })
    })
  }

  private recordToolCall(call: AgentToolCall, signal?: AbortSignal): Promise<void> {
    const requestId = this.createId()
    return this.waitForHostReply(this.pendingToolRecords, requestId, signal, () => {
      this.send({
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: 'tool.record',
        requestId,
        call,
      })
    })
  }

  private async proxyProviderFetch(
    runId: string,
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    const request = new Request(input, init)
    const signal = init.signal ?? request.signal
    if (signal.aborted) throw abortError(signal)
    const requestId = this.createId()
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.clone().text()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      cancel: () => {
        this.send({
          version: AGENT_WORKER_PROTOCOL_VERSION,
          type: 'provider.cancel',
          requestId,
        })
        const pending = this.pendingProviderResponses.get(requestId)
        if (pending) {
          pending.finished = true
          pending.abortCleanup()
          this.pendingProviderResponses.delete(requestId)
        }
      },
    })
    const providerRequest: AgentWorkerProviderRequest = {
      requestId,
      runId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(body === undefined ? {} : { body }),
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        this.send({
          version: AGENT_WORKER_PROTOCOL_VERSION,
          type: 'provider.cancel',
          requestId,
        })
        this.failProviderResponse(requestId, abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingProviderResponses.set(requestId, {
        resolve,
        reject,
        stream,
        controller,
        responseStarted: false,
        finished: false,
        abortCleanup: () => signal.removeEventListener('abort', onAbort),
      })
      this.send({
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: 'provider.request',
        request: providerRequest,
      })
    })
  }

  private startProviderResponse(
    requestId: string,
    status: number,
    headers: Record<string, string>,
  ): void {
    const pending = this.pendingProviderResponses.get(requestId)
    if (!pending || pending.finished) return
    pending.responseStarted = true
    pending.resolve(new Response(pending.stream, { status, headers }))
  }

  private pushProviderChunk(requestId: string, bodyBase64: string): void {
    const pending = this.pendingProviderResponses.get(requestId)
    if (!pending || pending.finished || !pending.responseStarted) return
    pending.controller.enqueue(decodeBase64(bodyBase64))
  }

  private finishProviderResponse(requestId: string): void {
    const pending = this.pendingProviderResponses.get(requestId)
    if (!pending || pending.finished) return
    pending.finished = true
    pending.abortCleanup()
    this.pendingProviderResponses.delete(requestId)
    if (pending.responseStarted) pending.controller.close()
    else pending.reject(new Error('Provider 响应在返回响应头前结束。'))
  }

  private failProviderResponse(requestId: string, error: Error): void {
    const pending = this.pendingProviderResponses.get(requestId)
    if (!pending || pending.finished) return
    pending.finished = true
    pending.abortCleanup()
    this.pendingProviderResponses.delete(requestId)
    if (pending.responseStarted) pending.controller.error(error)
    else pending.reject(error)
  }

  private waitForHostReply<T>(
    pending: Map<string, PendingHostReply<T>>,
    requestId: string,
    signal: AbortSignal | undefined,
    send: () => void,
    notifyAbort?: () => void,
  ): Promise<T> {
    if (pending.has(requestId)) return Promise.reject(new Error(`duplicate requestId ${requestId}`))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        pending.delete(requestId)
        notifyAbort?.()
        reject(abortError(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(requestId, {
        resolve,
        reject,
        abortCleanup: () => signal?.removeEventListener('abort', onAbort),
      })
      send()
    })
  }

  private resolvePending<T>(
    pending: Map<string, PendingHostReply<T>>,
    requestId: string,
    value: T,
  ) {
    const reply = pending.get(requestId)
    if (!reply) return
    pending.delete(requestId)
    reply.abortCleanup()
    reply.resolve(value)
  }

  private rejectPending(reason: string): void {
    for (const pending of [
      this.pendingTools,
      this.pendingAuthorizations,
      this.pendingToolRecords,
    ]) {
      for (const reply of pending.values()) {
        reply.abortCleanup()
        reply.reject(new Error(reason))
      }
      pending.clear()
    }
    for (const [requestId] of this.pendingProviderResponses) {
      this.failProviderResponse(requestId, new Error(reason))
    }
  }

  private emitHeartbeat(): void {
    this.send({
      version: AGENT_WORKER_PROTOCOL_VERSION,
      type: 'heartbeat',
      workerInstanceId: this.identity.workerInstanceId,
      activeRunIds: [...this.activeRunIds],
      occurredAt: this.now(),
    })
  }

  private sendRunError(requestId: string, runId: string, error: AgentWorkerError): void {
    this.send({
      version: AGENT_WORKER_PROTOCOL_VERSION,
      type: 'run.error',
      requestId,
      runId,
      error,
    })
  }

  private send(message: AgentWorkerMessage): void {
    this.options.channel.send(message)
  }
}

function normalizeWorkerError(error: unknown): AgentWorkerError {
  const code = runtimeContractErrorCode(error)
  if (code) {
    return {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    }
  }
  return {
    code: 'runtime_error',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

function runtimeContractErrorCode(
  error: unknown,
): 'duplicate_run' | 'run_not_found' | 'invalid_steer' | 'authorization_not_found' | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = Reflect.get(error, 'code')
  return code === 'duplicate_run' ||
    code === 'run_not_found' ||
    code === 'invalid_steer' ||
    code === 'authorization_not_found'
    ? code
    : null
}

function abortError(signal: AbortSignal | undefined): Error {
  const error = new Error(String(signal?.reason ?? 'Worker RPC aborted.'))
  error.name = 'AbortError'
  return error
}

function defaultCreateId(): string {
  return globalThis.crypto.randomUUID()
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}
