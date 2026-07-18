import type { AiChatMode, AiChatRole, AiChatStatus } from '@/models/aiChatMode'
import type { AgentRuntimeViewState } from '@/models/agentRuntime'
import type {
  CognitiveResultProvenance,
  LearningSessionState,
  LearningTurnResult,
  ResearchCandidateRef,
  ResearchResult,
  ReviewResult,
} from '@/models/cognitive'
import type { KnowledgeSource } from '@/models/knowledgeRetrieval'

export interface AiChatPanelMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  reasoningContent?: string
  sources?: KnowledgeSource[]
  researchResult?: ResearchResult
  cognitiveProvenance?: CognitiveResultProvenance
  researchCandidates?: ResearchCandidateRef[]
  reviewResult?: ReviewResult
  learningResult?: LearningTurnResult
  learningState?: LearningSessionState
  agentRuntime?: AgentRuntimeViewState
  status: AiChatStatus
}

export interface AiChatPanelHistoryItem {
  id: string
  projectId: string
  title: string
  updatedAt: number
  messageCount: number
  provider: string
  model: string
  pinnedAt: number | null
}

export interface AiChatWorkspaceOption {
  label: string
  value: string
}
