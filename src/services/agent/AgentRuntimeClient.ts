import {
  AgentRuntimeContractError,
  type AgentRunRequestV1,
  type AgentRunResult,
  type AgentRunSteerInput,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener,
  type AgentRuntimePort,
} from '@/models/agent/agentRuntimeContract'

export class AgentRuntimeClient implements AgentRuntimePort {
  private readonly claimedRunIds = new Set<string>()
  private readonly listeners = new Map<string, Set<AgentRuntimeEventListener>>()
  private readonly eventBuffers = new Map<string, AgentRuntimeEvent[]>()
  private readonly adapterUnsubscribers = new Map<string, () => void>()
  private readonly terminalRunIds = new Set<string>()

  constructor(private readonly adapter: AgentRuntimePort) {}

  async startRun(request: AgentRunRequestV1): Promise<AgentRunResult> {
    if (this.claimedRunIds.has(request.runId)) {
      throw new AgentRuntimeContractError(
        'duplicate_run',
        `run_id ${request.runId} 已由一个 Runtime adapter 驱动。`,
      )
    }
    this.claimedRunIds.add(request.runId)
    this.adapterUnsubscribers.set(
      request.runId,
      this.adapter.subscribeEvents(request.runId, (event) => this.publish(event)),
    )
    try {
      return await this.adapter.startRun(request)
    } finally {
      this.terminalRunIds.add(request.runId)
      this.cleanupIfUnused(request.runId)
    }
  }

  cancelRun(runId: string): Promise<void> {
    return this.adapter.cancelRun(runId)
  }

  steerRun(runId: string, input: AgentRunSteerInput): Promise<void> {
    return this.adapter.steerRun(runId, input)
  }

  subscribeEvents(runId: string, listener: AgentRuntimeEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<AgentRuntimeEventListener>()
    listeners.add(listener)
    this.listeners.set(runId, listeners)
    for (const event of this.eventBuffers.get(runId) ?? []) listener(event)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(runId)
      this.cleanupIfUnused(runId)
    }
  }

  private publish(event: AgentRuntimeEvent): void {
    const buffer = this.eventBuffers.get(event.runId) ?? []
    buffer.push(event)
    this.eventBuffers.set(event.runId, buffer)
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event)
  }

  private cleanupIfUnused(runId: string): void {
    if (!this.terminalRunIds.has(runId) || this.listeners.has(runId)) return
    this.adapterUnsubscribers.get(runId)?.()
    this.adapterUnsubscribers.delete(runId)
    this.eventBuffers.delete(runId)
  }
}
