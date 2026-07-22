import type {
  AgentCommunicationRepository,
  AgentCommunicationResult,
} from '@/repositories/agent/AgentCommunicationRepository'

export type {
  AgentCommunicationDecision,
  AgentCommunicationMode,
  AgentCommunicationRequest,
  AgentCommunicationResult,
  AgentCommunicationStatus,
} from '@/repositories/agent/AgentCommunicationRepository'

export class AgentCommunicationService {
  constructor(private readonly repository: AgentCommunicationRepository) {}

  claimNext() {
    return this.repository.claimNext()
  }

  claimRevisionForTask(taskId: string) {
    return this.repository.claimRevisionForTask(taskId)
  }

  findDecisionForTask(taskId: string) {
    return this.repository.findDecisionForTask(taskId)
  }

  findFailedForTask(taskId: string) {
    return this.repository.findFailedForTask(taskId)
  }

  listRecentCompleted(limit = 20) {
    return this.repository.listRecentCompleted(limit)
  }

  markAwaitingReview(id: string, taskId: string, result: AgentCommunicationResult) {
    return this.repository.markAwaitingReview(id, taskId, result)
  }

  markCompleted(id: string, taskId: string | null, result: AgentCommunicationResult | null = null) {
    return this.repository.markCompleted(id, taskId, result)
  }

  markFailed(id: string, taskId: string | null, error: string) {
    return this.repository.markFailed(id, taskId, error)
  }
}
