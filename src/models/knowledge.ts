export type KnowledgeObjectType = 'decision' | 'rule' | 'goal' | 'task' | 'evidence' | 'change_set'
export type KnowledgeObjectStatus = 'draft' | 'candidate' | 'approved' | 'active' | 'deprecated'
export type KnowledgeRelationType =
  | 'supersedes'
  | 'conflicts_with'
  | 'supports'
  | 'derives_from'
  | 'relates_to'

export interface KnowledgeObject {
  id: string
  objectType: KnowledgeObjectType
  status: KnowledgeObjectStatus
  title: string
  ownerId: string | null
  scope: Record<string, unknown>
  documentId: string | null
  blockId: string | null
  sourceRevision: number | null
  authorityLevel: string
  confidence: number | null
  validFrom: number | null
  validUntil: number | null
  verifiedAt: number | null
  version: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeRelation {
  id: string
  fromObjectId: string
  relationType: KnowledgeRelationType
  toObjectId: string
  createdAt: number
}

export interface CreateKnowledgeObjectInput {
  id: string
  objectType: KnowledgeObjectType
  status?: KnowledgeObjectStatus
  title: string
  ownerId?: string | null
  scope?: Record<string, unknown>
  documentId?: string | null
  blockId?: string | null
  sourceRevision?: number | null
  authorityLevel?: string
  confidence?: number | null
  validFrom?: number | null
  validUntil?: number | null
  verifiedAt?: number | null
  createdAt?: number
}

export function isKnowledgeObjectEffective(object: KnowledgeObject, at = Date.now()): boolean {
  return (
    (object.status === 'approved' || object.status === 'active') &&
    (object.validFrom === null || object.validFrom <= at) &&
    (object.validUntil === null || object.validUntil > at)
  )
}
