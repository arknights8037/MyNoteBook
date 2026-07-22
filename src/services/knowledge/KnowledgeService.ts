import type { CreateKnowledgeObjectInput, KnowledgeObject, KnowledgeObjectType } from '@/models/knowledge/knowledge'
import type { AppResult } from '@/models/shared/result'
import type { KnowledgeRepository } from '@/repositories/knowledge/KnowledgeRepository'

export class KnowledgeService {
  constructor(private readonly repository: KnowledgeRepository) {}

  create(input: CreateKnowledgeObjectInput): Promise<AppResult<KnowledgeObject>> {
    return this.repository.createObject(input)
  }

  listEffectiveContext(
    documentId: string,
    types: KnowledgeObjectType[] = ['rule', 'decision'],
    at = Date.now(),
  ): Promise<AppResult<KnowledgeObject[]>> {
    return this.repository.listObjects({ types, documentId, effectiveAt: at, limit: 100 })
  }
}
