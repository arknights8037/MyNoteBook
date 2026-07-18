import type {
  CreateKnowledgeObjectInput,
  KnowledgeObject,
  KnowledgeObjectType,
  KnowledgeRelation,
  KnowledgeRelationType,
  KnowledgeObjectSource,
  KnowledgeValidation,
} from '@/models/knowledge'
import type { AppResult } from '@/models/result'

export interface KnowledgeRepository {
  createObject(input: CreateKnowledgeObjectInput): Promise<AppResult<KnowledgeObject>>
  getObject(id: string): Promise<AppResult<KnowledgeObject>>
  listObjects(options?: {
    types?: KnowledgeObjectType[]
    documentId?: string
    effectiveAt?: number
    limit?: number
  }): Promise<AppResult<KnowledgeObject[]>>
  updateObject(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<CreateKnowledgeObjectInput, 'id' | 'objectType'>>,
  ): Promise<AppResult<KnowledgeObject>>
  deleteObject(id: string, expectedVersion: number): Promise<AppResult<void>>
  addRelation(input: {
    id: string
    fromObjectId: string
    relationType: KnowledgeRelationType
    toObjectId: string
    createdAt?: number
  }): Promise<AppResult<KnowledgeRelation>>
  listRelations(objectId: string): Promise<AppResult<KnowledgeRelation[]>>
  decideCandidate(input: {
    id: string
    expectedVersion: number
    decision: 'approved' | 'rejected'
  }): Promise<AppResult<KnowledgeObject>>
  addSource(input: KnowledgeObjectSource): Promise<AppResult<KnowledgeObjectSource>>
  listSources(objectId: string): Promise<AppResult<KnowledgeObjectSource[]>>
  addValidation(input: KnowledgeValidation): Promise<AppResult<KnowledgeValidation>>
  listValidations(objectId: string): Promise<AppResult<KnowledgeValidation[]>>
}
