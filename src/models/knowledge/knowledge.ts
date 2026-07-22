import type { CognitiveModeId } from '@/models/cognitive/cognitive'

export type KnowledgeObjectType =
  | 'decision'
  | 'rule'
  | 'goal'
  | 'task'
  | 'evidence'
  | 'change_set'
  | 'fact'
  | 'claim'
  | 'inference'
  | 'assumption'
  | 'concept'
  | 'question'
  | 'limitation'
export type KnowledgeObjectStatus =
  | 'draft'
  | 'candidate'
  | 'approved'
  | 'active'
  | 'deprecated'
  | 'rejected'
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
  content: string
  structuredData: Record<string, unknown>
  generatedRunId: string | null
  cognitiveMode: CognitiveModeId | null
  templateId: string | null
  templateVersion: number | null
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
  content?: string
  structuredData?: Record<string, unknown>
  generatedRunId?: string | null
  cognitiveMode?: CognitiveModeId | null
  templateId?: string | null
  templateVersion?: number | null
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

export interface KnowledgeObjectSource {
  id: string
  knowledgeObjectId: string
  documentId: string
  blockId: string | null
  revision: number
  quote: string | null
  startOffset: number | null
  endOffset: number | null
  createdAt: number
}

export type KnowledgeValidationVerdict = 'passed' | 'failed' | 'warning' | 'unverifiable'
export type KnowledgeValidationSeverity = 'info' | 'warning' | 'error'

export interface KnowledgeValidation {
  id: string
  knowledgeObjectId: string
  ruleId: string
  verdict: KnowledgeValidationVerdict
  severity: KnowledgeValidationSeverity
  message: string
  source: Record<string, unknown>
  validatedAt: number
}

export function isKnowledgeObjectEffective(object: KnowledgeObject, at = Date.now()): boolean {
  return (
    (object.status === 'approved' || object.status === 'active') &&
    (object.validFrom === null || object.validFrom <= at) &&
    (object.validUntil === null || object.validUntil > at)
  )
}
