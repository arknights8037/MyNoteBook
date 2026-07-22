import { describe, expect, it, vi } from 'vitest'
import type {
  AgentCommunicationRepository,
  AgentCommunicationResult,
} from '@/repositories/agent/AgentCommunicationRepository'
import { AgentCommunicationService } from '@/services/agent/AgentCommunicationService'

function createRepository(): AgentCommunicationRepository {
  return {
    claimNext: vi.fn().mockResolvedValue(null),
    claimRevisionForTask: vi.fn().mockResolvedValue(null),
    findDecisionForTask: vi.fn().mockResolvedValue(null),
    findFailedForTask: vi.fn().mockResolvedValue(null),
    listRecentCompleted: vi.fn().mockResolvedValue([]),
    markAwaitingReview: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  }
}

describe('AgentCommunicationService', () => {
  it('delegates communication queries to its repository port', async () => {
    const repository = createRepository()
    const service = new AgentCommunicationService(repository)

    await service.claimNext()
    await service.claimRevisionForTask('task-previous')
    await service.findDecisionForTask('task-1')
    await service.findFailedForTask('task-1')
    await service.listRecentCompleted(12)

    expect(repository.claimNext).toHaveBeenCalledOnce()
    expect(repository.claimRevisionForTask).toHaveBeenCalledWith('task-previous')
    expect(repository.findDecisionForTask).toHaveBeenCalledWith('task-1')
    expect(repository.findFailedForTask).toHaveBeenCalledWith('task-1')
    expect(repository.listRecentCompleted).toHaveBeenCalledWith(12)
  })

  it('delegates status transitions without owning persistence details', async () => {
    const repository = createRepository()
    const service = new AgentCommunicationService(repository)
    const result: AgentCommunicationResult = {
      version: 1,
      outcome: 'proposal',
      summary: '已自主检索并生成同步提案。',
      patchCount: 2,
      targetDocumentIds: ['doc-1', 'doc-2'],
    }

    await service.markAwaitingReview('request-1', 'task-1', result)
    await service.markCompleted('request-1', 'task-1')
    await service.markFailed('request-2', null, 'failed')

    expect(repository.markAwaitingReview).toHaveBeenCalledWith('request-1', 'task-1', result)
    expect(repository.markCompleted).toHaveBeenCalledWith('request-1', 'task-1', null)
    expect(repository.markFailed).toHaveBeenCalledWith('request-2', null, 'failed')
  })
})
