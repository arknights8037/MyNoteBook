import { describe, expect, it, vi } from 'vitest'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { GovernanceRepository } from '@/repositories/GovernanceRepository'
import type { KnowledgeRepository } from '@/repositories/KnowledgeRepository'
import type { ViewRepository } from '@/repositories/ViewRepository'
import type { WorkRepository } from '@/repositories/WorkRepository'
import { KnowledgeControlService } from './KnowledgeControlService'

describe('KnowledgeControlService', () => {
  it('loads the three control-plane read models through one application boundary', async () => {
    const knowledge = { listObjects: vi.fn(async () => ({ ok: true as const, value: [{ id: 'rule-1' }] })) }
    const views = { listDefinitions: vi.fn(async () => ({ ok: true as const, value: [{ id: 'view-1' }] })) }
    const work = { listRuns: vi.fn(async () => ({ ok: true as const, value: [{ id: 'run-1' }] })) }
    const service = createService(knowledge, views, work)

    const state = await service.load()

    expect(state.objects[0]).toMatchObject({ id: 'rule-1' })
    expect(state.views[0]).toMatchObject({ id: 'view-1' })
    expect(state.taskRuns[0]).toMatchObject({ id: 'run-1' })
  })

  it('owns Knowledge Object defaults instead of duplicating them in the page', async () => {
    const createObject = vi.fn(async (input) => ({ ok: true as const, value: input }))
    const service = createService({ createObject }, {}, {})
    await service.createKnowledgeObject({
      type: 'rule', title: '必须审批', documentId: 'doc-1', documentRevision: 4,
    })
    expect(createObject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'knowledge-id', status: 'active', authorityLevel: 'local_user',
      documentId: 'doc-1', sourceRevision: 4, verifiedAt: 100,
    }))
  })
})

function createService(knowledge: object, views: object, work: object) {
  return new KnowledgeControlService(
    knowledge as KnowledgeRepository,
    views as ViewRepository,
    work as WorkRepository,
    {} as DocumentRepository,
    {} as GovernanceRepository,
    { readTextFile: vi.fn(), writeTextFile: vi.fn() },
    (prefix) => `${prefix}-id`,
    () => 100,
    { generate: vi.fn() },
  )
}
