import type {
  CreateKnowledgeObjectInput,
  KnowledgeObject,
  KnowledgeObjectType,
  KnowledgeRelation,
  KnowledgeRelationType,
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
  addRelation(input: {
    id: string
    fromObjectId: string
    relationType: KnowledgeRelationType
    toObjectId: string
    createdAt?: number
  }): Promise<AppResult<KnowledgeRelation>>
  listRelations(objectId: string): Promise<AppResult<KnowledgeRelation[]>>
}
