import type { ExecutionPolicy } from '@/models/agent/executionPolicy'

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

export type ResearchItemKind =
  | 'claim'
  | 'evidence'
  | 'assumption'
  | 'inference'
  | 'limitation'
  | 'conflict'
  | 'question'

export type ResearchValidationStatus = 'verified' | 'warning' | 'unverified'

export interface ResearchSourceRef {
  documentId: string
  blockId: string
  revision: number
  quote: string
}

export interface ResearchResultItem {
  id: string
  kind: ResearchItemKind
  title: string
  content: string
  confidence: number | null
  validationStatus: ResearchValidationStatus
  validationMessage: string
  sources: ResearchSourceRef[]
}

export interface ResearchRelationProposal {
  fromItemId: string
  relationType: 'supports' | 'conflicts_with' | 'derives_from' | 'relates_to'
  toItemId: string
  explanation: string
}

export interface ResearchResult {
  summary: string
  items: ResearchResultItem[]
  relations: ResearchRelationProposal[]
  unresolvedQuestions: string[]
}

export interface CognitiveResultProvenance {
  sessionId: string
  runId: string
  modeId: CognitiveModeId
  modeVersion: number
  templateId: string | null
  templateVersion: number | null
  outputContractId: string
  createdAt: number
}

export type ResearchCandidateDecision = 'pending' | 'kept' | 'approved' | 'rejected'
export type ResearchCandidateSourceState = 'fresh' | 'stale' | 'unverified'

export interface ResearchCandidateRef {
  itemId: string
  candidateId: string
  version: number
  decision: ResearchCandidateDecision
  sourceState: ResearchCandidateSourceState
  title: string
  content: string
  error: string
}

export type ReviewIssueType =
  | 'unsupported_claim'
  | 'missing_source'
  | 'logical_gap'
  | 'conflict'
  | 'undefined_term'
  | 'missing_scope_or_assumption'
  | 'outdated_information'
  | 'evidence_mismatch'
  | 'ambiguity'

export type ReviewIssueSeverity = 'info' | 'warning' | 'error'

export interface ReviewIssue {
  id: string
  issueType: ReviewIssueType
  severity: ReviewIssueSeverity
  title: string
  explanation: string
  affectedText: string
  suggestedAction: string
  sources: ResearchSourceRef[]
  sourceState: 'fresh' | 'stale' | 'unverified'
}

export interface ReviewResult {
  summary: string
  issues: ReviewIssue[]
  unresolvedQuestions: string[]
}

export type LearningUnderstandingState =
  | 'not_assessed'
  | 'partial'
  | 'misconception'
  | 'demonstrated'
  | 'needs_review'

export type LearningPromptKind =
  | 'question'
  | 'guided_question'
  | 'hint'
  | 'counterexample'
  | 'transfer_question'
  | 'none'

export interface LearningFeedback {
  correctPoints: string[]
  omissions: string[]
  misconceptions: string[]
}

export interface LearningAttempt {
  id: string
  response: string
  feedback: LearningFeedback
  understandingState: LearningUnderstandingState
  evidence: string
  createdAt: number
}

export interface LearningSessionState {
  version: 1
  topic: string
  currentPrompt: string
  promptKind: LearningPromptKind
  hintLevel: number
  attempts: LearningAttempt[]
  understandingState: LearningUnderstandingState
  nextStep: 'await_attempt' | 'continue' | 'complete' | 'needs_review'
}

export interface LearningTurnResult {
  phase: 'waiting_user' | 'completed'
  feedback: LearningFeedback
  understandingState: LearningUnderstandingState
  evidence: string
  nextPrompt: {
    kind: LearningPromptKind
    content: string
    hintLevel: number
  }
  candidateUnderstanding: {
    title: string
    content: string
    confidence: number
  } | null
}
