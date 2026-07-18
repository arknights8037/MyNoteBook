import { describe, expect, it, vi } from 'vitest'

import type { CognitiveResultProvenance, ResearchCandidateRef } from '@/models/cognitive'
import type { KnowledgeObject } from '@/models/knowledge'
import { ok } from '@/models/result'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { KnowledgeRepository } from '@/repositories/KnowledgeRepository'
import { ResearchCandidateService } from './ResearchCandidateService'

describe('ResearchCandidateService', () => {
  it('maps research items to candidates with run provenance, sources and validation', async () => {
    const object = candidate()
    const knowledge = repository({ createObject: vi.fn(async () => ok(object)) })
    const service = createService(knowledge)

    const result = await service.createFromResult({
      provenance: provenance(),
      result: {
        summary: '完成',
        items: [
          {
            id: 'E1',
            kind: 'evidence',
            title: '稳定证据',
            content: '原文支持该结论。',
            confidence: 0.9,
            validationStatus: 'verified',
            validationMessage: '来源可定位。',
            sources: [{ documentId: 'doc-1', blockId: 'block-1', revision: 3, quote: '原文' }],
          },
        ],
        relations: [],
        unresolvedQuestions: [],
      },
    })

    expect(result).toMatchObject({ ok: true, value: [{ candidateId: 'candidate-1' }] })
    expect(knowledge.createObject).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'candidate',
        generatedRunId: 'run-1',
        cognitiveMode: 'research',
        templateId: 'research-conclusions',
        documentId: 'doc-1',
        sourceRevision: 3,
      }),
    )
    expect(knowledge.addSource).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', blockId: 'block-1', revision: 3 }),
    )
    expect(knowledge.addValidation).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'passed', ruleId: 'research-output-validation' }),
    )
  })

  it('increments the candidate version without replacing original run provenance', async () => {
    const current = candidate()
    const revised = { ...current, title: '修订标题', content: '修订内容', version: 2 }
    const knowledge = repository({
      getObject: vi.fn(async () => ok(current)),
      updateObject: vi.fn(async () => ok(revised)),
    })
    const service = createService(knowledge)

    const result = await service.revise({
      candidateId: current.id,
      expectedVersion: 1,
      title: '修订标题',
      content: '修订内容',
    })

    expect(result).toMatchObject({ ok: true, value: { version: 2, title: '修订标题' } })
    expect(knowledge.updateObject).toHaveBeenCalledWith(
      current.id,
      1,
      expect.not.objectContaining({ generatedRunId: expect.anything() }),
    )
  })

  it('revalidates every source before approval', async () => {
    const current = candidate()
    const verified = { ...current, verifiedAt: 20, version: 2 }
    const approved = { ...verified, status: 'approved' as const, version: 3 }
    const knowledge = repository({
      getObject: vi.fn(async () => ok(current)),
      listSources: vi.fn(async () =>
        ok([
          {
            id: 'source-1',
            knowledgeObjectId: current.id,
            documentId: 'doc-1',
            blockId: 'block-1',
            revision: 3,
            quote: '原文',
            startOffset: null,
            endOffset: null,
            createdAt: 1,
          },
        ]),
      ),
      updateObject: vi.fn(async () => ok(verified)),
      decideCandidate: vi.fn(async () => ok(approved)),
    })
    const documents = documentRepository(3)
    const service = createService(knowledge, documents)

    const result = await service.decide({
      candidateId: current.id,
      expectedVersion: 1,
      action: 'approve',
    })

    expect(result).toMatchObject({ ok: true, value: { decision: 'approved', version: 3 } })
    expect(documents.listBlocks).toHaveBeenCalledWith('doc-1')
    expect(knowledge.addValidation).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'source-revision-current', verdict: 'passed' }),
    )
    expect(knowledge.decideCandidate).toHaveBeenCalledWith({
      id: current.id,
      expectedVersion: 2,
      decision: 'approved',
    })
  })

  it('blocks approval and records a failed validation when a source revision changed', async () => {
    const current = candidate()
    const knowledge = repository({
      getObject: vi.fn(async () => ok(current)),
      listSources: vi.fn(async () =>
        ok([
          {
            id: 'source-1',
            knowledgeObjectId: current.id,
            documentId: 'doc-1',
            blockId: 'block-1',
            revision: 3,
            quote: '原文',
            startOffset: null,
            endOffset: null,
            createdAt: 1,
          },
        ]),
      ),
    })
    const service = createService(knowledge, documentRepository(4))

    const result = await service.decide({
      candidateId: current.id,
      expectedVersion: 1,
      action: 'approve',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'revision-conflict' } })
    expect(knowledge.addValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: 'failed',
        source: expect.objectContaining({ expectedRevision: 3, currentRevision: 4 }),
      }),
    )
    expect(knowledge.decideCandidate).not.toHaveBeenCalled()
  })

  it('creates proposed relations only after both candidates are approved', async () => {
    const knowledge = repository()
    const service = createService(knowledge)
    const refs: ResearchCandidateRef[] = [
      candidateRef('C1', 'candidate-1', 'approved'),
      candidateRef('C2', 'candidate-2', 'approved'),
    ]

    const result = await service.materializeApprovedRelations({
      candidates: refs,
      relations: [
        {
          fromItemId: 'C1',
          relationType: 'supports',
          toItemId: 'C2',
          explanation: '支持',
        },
      ],
    })

    expect(result).toEqual(ok(undefined))
    expect(knowledge.addRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        fromObjectId: 'candidate-1',
        relationType: 'supports',
        toObjectId: 'candidate-2',
      }),
    )
  })
})

function createService(
  knowledge: KnowledgeRepository,
  documents: DocumentRepository = documentRepository(3),
) {
  let index = 0
  return new ResearchCandidateService(
    knowledge,
    documents,
    (prefix) => {
      index += 1
      return prefix === 'knowledge-candidate' ? 'candidate-1' : `${prefix}-${index}`
    },
    () => 20,
  )
}

function repository(overrides: Partial<KnowledgeRepository> = {}): KnowledgeRepository {
  return {
    createObject: vi.fn(async () => ok(candidate())),
    getObject: vi.fn(async () => ok(candidate())),
    listObjects: vi.fn(async () => ok([])),
    updateObject: vi.fn(async () => ok({ ...candidate(), version: 2 })),
    addRelation: vi.fn(async (input) => ok({ ...input, createdAt: input.createdAt ?? 20 })),
    listRelations: vi.fn(async () => ok([])),
    decideCandidate: vi.fn(async () => ok({ ...candidate(), status: 'approved', version: 2 })),
    addSource: vi.fn(async (input) => ok(input)),
    listSources: vi.fn(async () => ok([])),
    addValidation: vi.fn(async (input) => ok(input)),
    listValidations: vi.fn(async () => ok([])),
    ...overrides,
  }
}

function documentRepository(revision: number): DocumentRepository {
  return {
    findById: vi.fn(async () =>
      ok({
        id: 'doc-1',
        parentId: null,
        documentKind: 'article',
        title: '来源',
        tags: [],
        sourceUrl: '',
        author: '',
        description: '',
        contentJson: '{}',
        plainText: '原文',
        schemaVersion: 2,
        revision,
        sortOrder: 0,
        isDeleted: false,
        createdAt: 1,
        updatedAt: 1,
      }),
    ),
    listBlocks: vi.fn(async () =>
      ok([
        {
          id: 'block-1',
          documentId: 'doc-1',
          documentRevision: revision,
          index: 0,
          type: 'paragraph',
          contentJson: '{}',
          plainText: '原文',
        },
      ]),
    ),
  } as unknown as DocumentRepository
}

function candidate(): KnowledgeObject {
  return {
    id: 'candidate-1',
    objectType: 'evidence',
    status: 'candidate',
    title: '稳定证据',
    content: '原文支持该结论。',
    structuredData: { researchItemId: 'E1', researchKind: 'evidence', reviewState: 'pending' },
    generatedRunId: 'run-1',
    cognitiveMode: 'research',
    templateId: 'research-conclusions',
    templateVersion: 1,
    ownerId: null,
    scope: {},
    documentId: 'doc-1',
    blockId: 'block-1',
    sourceRevision: 3,
    authorityLevel: 'agent_candidate',
    confidence: 0.9,
    validFrom: null,
    validUntil: null,
    verifiedAt: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function provenance(): CognitiveResultProvenance {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    modeId: 'research',
    modeVersion: 1,
    templateId: 'research-conclusions',
    templateVersion: 1,
    outputContractId: 'research-result',
    createdAt: 1,
  }
}

function candidateRef(
  itemId: string,
  candidateId: string,
  decision: ResearchCandidateRef['decision'],
): ResearchCandidateRef {
  return {
    itemId,
    candidateId,
    version: 2,
    decision,
    sourceState: 'fresh',
    title: itemId,
    content: itemId,
    error: '',
  }
}
