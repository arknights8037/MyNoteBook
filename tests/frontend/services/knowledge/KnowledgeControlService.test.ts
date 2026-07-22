import { describe, expect, it, vi } from 'vitest'
import type { DocumentRepository } from '@/repositories/documents/DocumentRepository'
import type { GovernanceRepository } from '@/repositories/knowledge/GovernanceRepository'
import type { KnowledgeRepository } from '@/repositories/knowledge/KnowledgeRepository'
import type { ViewRepository } from '@/repositories/knowledge/ViewRepository'
import type { WorkRepository } from '@/repositories/knowledge/WorkRepository'
import { KnowledgeControlService } from '@/services/knowledge/KnowledgeControlService'

describe('KnowledgeControlService', () => {
  it('loads the three control-plane read models through one application boundary', async () => {
    const knowledge = {
      listObjects: vi.fn(async () => ({ ok: true as const, value: [{ id: 'rule-1' }] })),
    }
    const views = {
      listDefinitions: vi.fn(async () => ({ ok: true as const, value: [{ id: 'view-1' }] })),
    }
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
      type: 'rule',
      title: '必须审批',
      documentId: 'doc-1',
      documentRevision: 4,
    })
    expect(createObject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'knowledge-id',
        status: 'active',
        authorityLevel: 'local_user',
        documentId: 'doc-1',
        sourceRevision: 4,
        verifiedAt: 100,
      }),
    )
  })

  it('loads content, sources, validations and relations for knowledge review', async () => {
    const service = createService(
      {
        getObject: vi.fn(async () => ({ ok: true, value: { id: 'claim-1', title: '结论' } })),
        listSources: vi.fn(async () => ({ ok: true, value: [{ id: 'source-1' }] })),
        listValidations: vi.fn(async () => ({ ok: true, value: [{ id: 'validation-1' }] })),
        listRelations: vi.fn(async () => ({ ok: true, value: [{ id: 'relation-1' }] })),
      },
      {},
      {},
    )

    const detail = await service.getKnowledgeObjectDetail('claim-1')

    expect(detail.object).toMatchObject({ id: 'claim-1' })
    expect(detail.sources).toHaveLength(1)
    expect(detail.validations).toHaveLength(1)
    expect(detail.relations).toHaveLength(1)
  })

  it('updates user classification without replacing Research provenance', async () => {
    const current = {
      id: 'claim-1',
      version: 2,
      structuredData: { researchItemId: 'C1', validationStatus: 'warning' },
    }
    const updateObject = vi.fn(async (_id, _version, patch) => ({
      ok: true as const,
      value: { ...current, ...patch, version: 3 },
    }))
    const service = createService(
      {
        getObject: vi.fn(async () => ({ ok: true as const, value: current })),
        updateObject,
      },
      {},
      {},
    )

    await service.updateKnowledgeObjectMetadata({
      id: 'claim-1',
      expectedVersion: 2,
      category: 'Agent 架构',
      tags: ['运行时', '架构', '运行时'],
    })

    expect(updateObject).toHaveBeenCalledWith(
      'claim-1',
      2,
      expect.objectContaining({
        structuredData: {
          researchItemId: 'C1',
          validationStatus: 'warning',
          userCategory: 'Agent 架构',
          userTags: ['运行时', '架构'],
        },
      }),
    )
  })

  it('imports an AI conversation as a background-processing asset', async () => {
    const createObject = vi.fn(async (input) => ({ ok: true as const, value: input }))
    const save = vi.fn(async (input) => ({ ok: true as const, value: { ...input, revision: 1 } }))
    const service = createService({ createObject }, {}, {}, { save })

    await service.importAiConversation({
      id: 'chat-1',
      projectId: 'project-1',
      title: '需求讨论',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      provider: 'openai',
      model: 'gpt-5',
      pinnedAt: null,
      messages: [{ id: 'm1', role: 'user', mode: 'ask', content: '整理需求', status: 'done' }],
    })

    expect(save).not.toHaveBeenCalled()
    expect(createObject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'knowledge-asset-id',
        objectType: 'evidence',
        documentId: null,
        sourceRevision: null,
        scope: { backgroundProcessing: true, directlyVisible: false },
        structuredData: expect.objectContaining({
          kind: 'document_asset',
          sourceType: 'ai_chat',
          conversationId: 'chat-1',
          contentFormat: 'markdown',
          processingStatus: 'pending',
          automationPurpose: 'summarize_and_index',
        }),
      }),
    )
  })

  it('deletes the knowledge asset and its stored original', async () => {
    const getObject = vi.fn(async () => ({
      ok: true as const,
      value: { id: 'asset-object-1', version: 3, structuredData: { kind: 'document_asset' } },
    }))
    const deleteObject = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const deleteAsset = vi.fn(async () => undefined)
    const service = createService({ getObject, deleteObject }, {}, {}, {}, { deleteAsset })

    await service.deleteKnowledgeAsset({
      id: 'asset-object-1',
      title: '会议记录',
      sourceType: 'text_file',
      format: 'MARKDOWN',
      documentId: null,
      assetId: 'stored-asset-1',
      originalName: 'meeting.md',
      mimeType: 'text/markdown',
      sizeBytes: 12,
      characterCount: 8,
      provider: '',
      model: '',
      conversationId: '',
      messageCount: 0,
      importBatchId: '',
      importBatchName: '',
      archivePath: '',
      importedFromArchive: false,
      processingStatus: 'pending',
      content: '# 会议记录',
      createdAt: 1,
      updatedAt: 1,
    })

    expect(deleteObject).toHaveBeenCalledWith('asset-object-1', 3)
    expect(deleteAsset).toHaveBeenCalledWith('stored-asset-1')
  })

  it('imports only selected JSON entries using their chosen parse mode', async () => {
    const createObject = vi.fn(async (input) => ({ ok: true as const, value: input }))
    const storeFile = vi.fn(async (file: File) => ({
      id: `stored-${file.name}`,
      originalName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    }))
    const service = createService({ createObject }, {}, {}, {}, { storeFile })
    const candidate = {
      file: new File(['{"owner":"Ada"}'], 'project.json', { type: 'application/json' }),
      originalPath: 'exports/project.json',
      title: 'project',
      text: '# project\n\n- **owner：** Ada',
      markdownText: '# project\n\n- **owner：** Ada',
      conversationText: null,
      format: 'AI CHAT · JSON',
      provider: '',
      model: '',
      messageCount: 0,
      availableModes: ['markdown' as const],
      defaultMode: 'markdown' as const,
    }

    const result = await service.importAiConversationSelections(
      [{ candidate, mode: 'markdown' }],
      [],
      'chat-export.zip',
    )

    expect(result).toEqual({ imported: 1, failures: [] })
    expect(storeFile).toHaveBeenCalledTimes(1)
    expect(createObject).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredData: expect.objectContaining({
          sourceType: 'text_file',
          format: 'JSON · MARKDOWN',
          messageCount: 0,
          importBatchId: 'asset-batch-id',
          importBatchName: 'chat-export.zip',
          archivePath: 'exports/project.json',
          importedFromArchive: true,
        }),
      }),
    )
  })
})

function createService(
  knowledge: object,
  views: object,
  work: object,
  documents: object = {},
  assets?: object,
) {
  return new KnowledgeControlService(
    knowledge as KnowledgeRepository,
    views as ViewRepository,
    work as WorkRepository,
    documents as DocumentRepository,
    {} as GovernanceRepository,
    { readTextFile: vi.fn(), writeTextFile: vi.fn() },
    (prefix) => `${prefix}-id`,
    () => 100,
    { generate: vi.fn() },
    assets as never,
  )
}
