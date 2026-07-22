import { describe, expect, it, vi } from 'vitest'

import { ViewService } from '@/services/workspace/ViewService'
import type { DocumentRepository } from '@/repositories/documents/DocumentRepository'
import type { KnowledgeRepository } from '@/repositories/knowledge/KnowledgeRepository'
import type { ViewRepository } from '@/repositories/knowledge/ViewRepository'
import type { ViewDefinition } from '@/models/knowledge/view'

describe('ViewService', () => {
  it('refreshes a Query View with revisioned dependencies and a snapshot hash', async () => {
    const definition = createDefinition('query', { query: '规则', limit: 10 })
    const commitRefresh = vi.fn(async ({ snapshot }) => ({ ok: true as const, value: snapshot }))
    const views = {
      getDefinition: vi.fn(async () => ({ ok: true as const, value: definition })),
      commitRefresh,
    } as unknown as ViewRepository
    const documents = {
      searchKnowledge: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 'doc-1',
            title: '规则文档',
            plainText: '审批规则',
            revision: 7,
            documentKind: 'article',
            isDeleted: false,
            tags: [],
          },
        ],
      })),
    } as unknown as DocumentRepository
    const service = new ViewService(
      views,
      documents,
      {} as KnowledgeRepository,
      () => 'snapshot-1',
      () => 100,
    )

    const result = await service.refresh('view-1')

    expect(result.ok).toBe(true)
    expect(commitRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencies: [
          expect.objectContaining({ documentId: 'doc-1', sourceRevision: 7 }),
        ],
        snapshot: expect.objectContaining({
          status: 'fresh',
          sourceSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    )
  })

  it('refreshes a Projection View from documents and Knowledge Objects without writeback', async () => {
    const definition = createDefinition('projection', {
      documentIds: ['doc-1'],
      knowledgeObjectIds: ['rule-1'],
    })
    const commitRefresh = vi.fn(async ({ snapshot }) => ({ ok: true as const, value: snapshot }))
    const views = {
      getDefinition: vi.fn(async () => ({ ok: true as const, value: definition })),
      commitRefresh,
    } as unknown as ViewRepository
    const documents = {
      findById: vi.fn(async () => ({
        ok: true as const,
        value: { id: 'doc-1', title: '文档', revision: 3, plainText: '正文' },
      })),
    } as unknown as DocumentRepository
    const knowledge = {
      getObject: vi.fn(async () => ({
        ok: true as const,
        value: {
          id: 'rule-1',
          objectType: 'rule',
          status: 'active',
          title: '必须审批',
          documentId: 'doc-1',
          blockId: 'b1',
          sourceRevision: 3,
          version: 2,
        },
      })),
    } as unknown as KnowledgeRepository
    const service = new ViewService(views, documents, knowledge, () => 'snapshot-1', () => 100)

    await service.refresh('view-1')

    expect(commitRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencies: expect.arrayContaining([
          expect.objectContaining({ documentId: 'doc-1', sourceRevision: 3 }),
          expect.objectContaining({ knowledgeObjectId: 'rule-1', sourceRevision: 2 }),
        ]),
      }),
    )
  })

  it('keeps a generated refresh as a protected preview when the user has an override', async () => {
    const definition = {
      ...createDefinition('generated', { documentIds: ['doc-1'] }),
      generation: { prompt: '总结', provider: 'openai', model: 'gpt-5-mini', skillVersions: [{ id: 'summary', version: '1' }] },
      manualOverride: true,
      overrideContent: { content: '用户版本' },
    }
    const commitRefresh = vi.fn(async ({ snapshot }) => ({ ok: true as const, value: snapshot }))
    const views = { getDefinition: vi.fn(async () => ({ ok: true as const, value: definition })), commitRefresh } as unknown as ViewRepository
    const documents = { findById: vi.fn(async () => ({ ok: true as const, value: { id: 'doc-1', title: '文档', revision: 9, plainText: '事实' } })) } as unknown as DocumentRepository
    const executor = { generate: vi.fn(async () => ({ ok: true as const, value: { content: '新生成版本' } })) }
    const service = new ViewService(views, documents, {} as KnowledgeRepository, () => 'snapshot-generated', () => 200, undefined, executor)

    await service.refresh('view-1')

    expect(commitRefresh).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        status: 'preview', protectedByOverride: true, provider: 'openai', model: 'gpt-5-mini',
      }),
    }))
  })
})

function createDefinition(
  viewType: ViewDefinition['viewType'],
  scopeQuery: Record<string, unknown>,
): ViewDefinition {
  return {
    id: 'view-1',
    name: '测试视图',
    viewType,
    scopeQuery,
    projectionSchema: null,
    renderSpec: {},
    refreshPolicy: 'manual',
    writebackPolicy: 'readonly',
    targetDocumentId: null,
    generation: null,
    manualOverride: false,
    overrideContent: null,
    overrideUpdatedAt: null,
    stale: true,
    version: 1,
    currentSnapshotId: null,
    lastRefreshedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}
