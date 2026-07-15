import type { ExecutionPolicy } from './executionPolicy'

export type CognitiveModeId = 'learning' | 'research' | 'review'
export type CognitiveSessionStatus = 'active' | 'waiting_user' | 'completed' | 'cancelled'
export type AgentToolTag =
  | 'document.read'
  | 'document.propose_write'
  | 'knowledge.read'
  | 'knowledge.propose_write'
  | 'knowledge.validate'
  | 'system.inspect'
  | 'external.read'
  | 'external.may_write'
  | 'cognition.interact'

export interface CognitiveInteractionPolicy {
  allowUserInput: boolean
  allowWriteProposals: boolean
  requireUserAttempt?: boolean
}

export interface CognitiveContextPolicy {
  includeCurrentDocument: boolean
  includeSelection: boolean
  includeEffectiveKnowledge: boolean
  includeSessionState: boolean
  maxSourceDocuments: number
}

export interface CognitiveModeDefinition {
  id: CognitiveModeId
  name: string
  description: string
  interactionPolicy: CognitiveInteractionPolicy
  contextPolicy: CognitiveContextPolicy
  outputContractId: string
  allowedToolTags: AgentToolTag[]
  deniedToolTags: AgentToolTag[]
  defaultSkillIds: string[]
  defaultTemplateId: string | null
  systemInstructionFragments: string[]
  version: number
  enabled: boolean
}

export interface KnowledgeControlTemplate {
  id: string
  name: string
  applicableModes: CognitiveModeId[]
  extractionRules: Array<Record<string, unknown>>
  validationRules: Array<Record<string, unknown>>
  conflictRules: Array<Record<string, unknown>>
  approvalPolicy: Record<string, unknown>
  promptFragments: string[]
  version: number
  enabled: boolean
}

export interface CognitiveRunSpec {
  modeId: CognitiveModeId
  modeVersion: number
  templateId: string | null
  templateVersion: number | null
  skillIds: string[]
  interactionPolicy: CognitiveInteractionPolicy
  contextPolicy: CognitiveContextPolicy
  executionPolicy: ExecutionPolicy
  outputContractId: string
  promptFragments: string[]
}

export interface CognitiveSession {
  id: string
  conversationId: string
  modeId: CognitiveModeId
  modeVersion: number
  templateId: string | null
  templateVersion: number | null
  skillIds: string[]
  targetDocumentIds: string[]
  targetBlockIds: string[]
  state: Record<string, unknown>
  status: CognitiveSessionStatus
  version: number
  createdAt: number
  updatedAt: number
}

export interface CreateCognitiveSessionInput extends Omit<
  CognitiveSession,
  'status' | 'version' | 'createdAt' | 'updatedAt'
> {
  status?: CognitiveSessionStatus
  createdAt?: number
}
