import type { AiChatMode, AiChatRole, AiChatStatus } from '@/models/ai/aiChatMode'
import type { AgentRuntimeViewState } from '@/models/agent/agentRuntime'
import type {
  CognitiveResultProvenance,
  LearningSessionState,
  LearningTurnResult,
  ResearchCandidateRef,
  ResearchResult,
  ReviewResult,
} from '@/models/cognitive/cognitive'
import type { KnowledgeSource } from '@/models/knowledge/knowledgeRetrieval'

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
