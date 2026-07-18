import type {
  CognitiveResultProvenance,
  ResearchCandidateRef,
  ResearchRelationProposal,
  ResearchResult,
  ResearchResultItem,
} from '@/models/cognitive'
import type {
  KnowledgeObject,
  KnowledgeObjectType,
  KnowledgeRelationType,
} from '@/models/knowledge'
import { err, ok, type AppResult } from '@/models/result'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { KnowledgeRepository } from '@/repositories/KnowledgeRepository'

export type ResearchCandidateAction = 'keep' | 'approve' | 'reject'

export class ResearchCandidateService {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly documents: DocumentRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  async createFromResult(input: {
    result: ResearchResult
    provenance: CognitiveResultProvenance
  }): Promise<AppResult<ResearchCandidateRef[]>> {
    const refs: ResearchCandidateRef[] = []
    for (const item of input.result.items) {
      const created = await this.createCandidate(item, input.provenance)
      if (!created.ok) return created
      refs.push(created.value)
    }
    return ok(refs)
  }

  async revise(input: {
    candidateId: string
    expectedVersion: number
    title: string
    content: string
  }): Promise<AppResult<ResearchCandidateRef>> {
    const title = input.title.trim()
    const content = input.content.trim()
    if (!title || !content) {
      return err({ code: 'validation-error', message: '候选标题和内容不能为空。' })
    }
    const current = await this.knowledge.getObject(input.candidateId)
    if (!current.ok) return current
    if (current.value.status !== 'candidate') {
      return err({ code: 'validation-error', message: '只有待确认 candidate 可以编辑。' })
    }
    const updated = await this.knowledge.updateObject(input.candidateId, input.expectedVersion, {
      title,
      content,
      structuredData: {
        ...current.value.structuredData,
        reviewState: 'pending',
        revisedAt: this.now(),
      },
    })
    return updated.ok ? ok(projectCandidateRef(updated.value)) : updated
  }

  async decide(input: {
    candidateId: string
    expectedVersion: number
    action: ResearchCandidateAction
  }): Promise<AppResult<ResearchCandidateRef>> {
    const current = await this.knowledge.getObject(input.candidateId)
    if (!current.ok) return current
    if (current.value.status !== 'candidate') {
      return err({ code: 'validation-error', message: '该候选已经处理，不能重复决策。' })
    }
    if (input.action === 'keep') {
      const kept = await this.knowledge.updateObject(input.candidateId, input.expectedVersion, {
        structuredData: {
          ...current.value.structuredData,
          reviewState: 'kept',
          keptAt: this.now(),
        },
      })
      return kept.ok ? ok(projectCandidateRef(kept.value, 'kept')) : kept
    }
    if (input.action === 'reject') {
      const rejected = await this.knowledge.decideCandidate({
        id: input.candidateId,
        expectedVersion: input.expectedVersion,
        decision: 'rejected',
      })
      return rejected.ok ? ok(projectCandidateRef(rejected.value)) : rejected
    }

    const freshness = await this.validateSourceFreshness(current.value)
    if (!freshness.ok) return freshness
    let version = input.expectedVersion
    if (freshness.value === 'fresh') {
      const verified = await this.knowledge.updateObject(input.candidateId, version, {
        verifiedAt: this.now(),
        structuredData: { ...current.value.structuredData, reviewState: 'approved' },
      })
      if (!verified.ok) return verified
      version = verified.value.version
    }
    const approved = await this.knowledge.decideCandidate({
      id: input.candidateId,
      expectedVersion: version,
      decision: 'approved',
    })
    return approved.ok ? ok(projectCandidateRef(approved.value)) : approved
  }

  async materializeApprovedRelations(input: {
    relations: ResearchRelationProposal[]
    candidates: ResearchCandidateRef[]
  }): Promise<AppResult<void>> {
    const byItemId = new Map(input.candidates.map((candidate) => [candidate.itemId, candidate]))
    for (const proposal of input.relations) {
      const from = byItemId.get(proposal.fromItemId)
      const to = byItemId.get(proposal.toItemId)
      if (!from || !to || from.decision !== 'approved' || to.decision !== 'approved') continue
      const existing = await this.knowledge.listRelations(from.candidateId)
      if (!existing.ok) return existing
      if (
        existing.value.some(
          (relation) =>
            relation.fromObjectId === from.candidateId &&
            relation.toObjectId === to.candidateId &&
            relation.relationType === proposal.relationType,
        )
      ) {
        continue
      }
      const created = await this.knowledge.addRelation({
        id: this.createId('knowledge-relation'),
        fromObjectId: from.candidateId,
        relationType: proposal.relationType as KnowledgeRelationType,
        toObjectId: to.candidateId,
        createdAt: this.now(),
      })
      if (!created.ok) return created
    }
    return ok(undefined)
  }

  private async createCandidate(
    item: ResearchResultItem,
    provenance: CognitiveResultProvenance,
  ): Promise<AppResult<ResearchCandidateRef>> {
    const primarySource = item.sources[0]
    const candidateId = this.createId('knowledge-candidate')
    const createdAt = this.now()
    const created = await this.knowledge.createObject({
      id: candidateId,
      objectType: mapResearchKind(item.kind),
      status: 'candidate',
      title: item.title,
      content: item.content,
      structuredData: {
        researchItemId: item.id,
        researchKind: item.kind,
        validationStatus: item.validationStatus,
        validationMessage: item.validationMessage,
        reviewState: 'pending',
        originalTitle: item.title,
        originalContent: item.content,
        sessionId: provenance.sessionId,
        outputContractId: provenance.outputContractId,
      },
      generatedRunId: provenance.runId,
      cognitiveMode: provenance.modeId,
      templateId: provenance.templateId,
      templateVersion: provenance.templateVersion,
      documentId: primarySource?.documentId ?? null,
      blockId: primarySource?.blockId ?? null,
      sourceRevision: primarySource?.revision ?? null,
      authorityLevel: 'agent_candidate',
      confidence: item.confidence,
      createdAt,
    })
    if (!created.ok) return created

    for (const source of item.sources) {
      const added = await this.knowledge.addSource({
        id: this.createId('knowledge-source'),
        knowledgeObjectId: candidateId,
        documentId: source.documentId,
        blockId: source.blockId,
        revision: source.revision,
        quote: source.quote,
        startOffset: null,
        endOffset: null,
        createdAt,
      })
      if (!added.ok) return added
    }
    const validation = await this.knowledge.addValidation({
      id: this.createId('knowledge-validation'),
      knowledgeObjectId: candidateId,
      ruleId: 'research-output-validation',
      verdict:
        item.validationStatus === 'verified'
          ? 'passed'
          : item.validationStatus === 'warning'
            ? 'warning'
            : 'unverifiable',
      severity: item.validationStatus === 'verified' ? 'info' : 'warning',
      message: item.validationMessage,
      source: { itemId: item.id, sourceCount: item.sources.length },
      validatedAt: createdAt,
    })
    if (!validation.ok) return validation
    return ok(projectCandidateRef(created.value))
  }

  private async validateSourceFreshness(
    candidate: KnowledgeObject,
  ): Promise<AppResult<'fresh' | 'unverified'>> {
    const sources = await this.knowledge.listSources(candidate.id)
    if (!sources.ok) return sources
    if (sources.value.length === 0) return ok('unverified')

    for (const source of sources.value) {
      const document = await this.documents.findById(source.documentId)
      const blocks = document.ok ? await this.documents.listBlocks(source.documentId) : null
      const currentRevision = document.ok ? document.value.revision : null
      const blockExists =
        blocks?.ok && (!source.blockId || blocks.value.some((block) => block.id === source.blockId))
      if (!document.ok || currentRevision !== source.revision || !blockExists) {
        await this.knowledge.addValidation({
          id: this.createId('knowledge-validation'),
          knowledgeObjectId: candidate.id,
          ruleId: 'source-revision-current',
          verdict: 'failed',
          severity: 'error',
          message: '来源文档或块已变化，需要重新验证后才能接受。',
          source: {
            documentId: source.documentId,
            blockId: source.blockId,
            expectedRevision: source.revision,
            currentRevision,
          },
          validatedAt: this.now(),
        })
        return err({
          code: 'revision-conflict',
          message: '来源 revision 已失效，需要重新验证后才能接受。',
        })
      }
    }
    const validation = await this.knowledge.addValidation({
      id: this.createId('knowledge-validation'),
      knowledgeObjectId: candidate.id,
      ruleId: 'source-revision-current',
      verdict: 'passed',
      severity: 'info',
      message: '所有来源 revision 和稳定块仍然有效。',
      source: { sourceCount: sources.value.length },
      validatedAt: this.now(),
    })
    return validation.ok ? ok('fresh') : validation
  }
}

function mapResearchKind(kind: ResearchResultItem['kind']): KnowledgeObjectType {
  return kind === 'conflict' ? 'claim' : kind
}

function projectCandidateRef(
  candidate: KnowledgeObject,
  forcedDecision?: ResearchCandidateRef['decision'],
): ResearchCandidateRef {
  const reviewState = candidate.structuredData.reviewState
  const decision =
    forcedDecision ??
    (candidate.status === 'approved'
      ? 'approved'
      : candidate.status === 'rejected'
        ? 'rejected'
        : reviewState === 'kept'
          ? 'kept'
          : 'pending')
  return {
    itemId: String(candidate.structuredData.researchItemId ?? ''),
    candidateId: candidate.id,
    version: candidate.version,
    decision,
    sourceState:
      candidate.sourceRevision === null
        ? 'unverified'
        : candidate.status === 'candidate' || candidate.status === 'approved'
          ? 'fresh'
          : 'unverified',
    title: candidate.title,
    content: candidate.content,
    error: '',
  }
}
