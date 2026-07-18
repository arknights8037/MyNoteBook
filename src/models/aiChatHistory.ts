import type { AiChatMode, AiChatRole, AiChatStatus } from './aiChatMode'
import type { AgentRuntimeViewState } from './agentRuntime'
import type {
  CognitiveResultProvenance,
  LearningSessionState,
  LearningTurnResult,
  ResearchCandidateRef,
  ResearchResult,
  ReviewResult,
} from './cognitive'

export interface AiChatHistoryMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  reasoningContent?: string
  researchResult?: ResearchResult
  cognitiveProvenance?: CognitiveResultProvenance
  researchCandidates?: ResearchCandidateRef[]
  reviewResult?: ReviewResult
  learningResult?: LearningTurnResult
  learningState?: LearningSessionState
  agentRuntime?: AgentRuntimeViewState
  status: AiChatStatus
}

export interface AgentProject {
  id: string
  name: string
  workspaceRootIds: string[]
  pinnedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AiChatHistoryItem {
  id: string
  projectId: string
  parentConversationId?: string | null
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  provider: string
  model: string
  pinnedAt: number | null
  messages: AiChatHistoryMessage[]
}

export interface AgentWorkspaceHistoryState {
  projects: AgentProject[]
  activeProjectId: string
  items: AiChatHistoryItem[]
}

interface AgentWorkspaceHistoryPayload extends AgentWorkspaceHistoryState {
  version: 2 | 3
}

const LEGACY_HISTORY_STORAGE_KEYS = [
  'my-notebook:ai-chat-history',
  'my-notebook:agent-workspace-history:v2',
]
export const DEFAULT_AGENT_PROJECT_ID = 'agent-project-default'
export const UNGROUPED_AGENT_PROJECT_ID = 'agent-project-ungrouped'
export const AI_CHAT_HISTORY_LIMIT = 100

export function createEmptyAgentWorkspaceHistory(): AgentWorkspaceHistoryState {
  const now = Date.now()
  return {
    projects: [
      {
        id: DEFAULT_AGENT_PROJECT_ID,
        name: 'Agent MVP',
        workspaceRootIds: [],
        pinnedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    activeProjectId: DEFAULT_AGENT_PROJECT_ID,
    items: [],
  }
}

export function purgeLegacyAgentHistoryStorage(): void {
  try {
    for (const key of LEGACY_HISTORY_STORAGE_KEYS) globalThis.localStorage?.removeItem(key)
  } catch {
    // Ignore unavailable storage.
  }
}

export function normalizeAgentWorkspaceHistory(value: unknown): AgentWorkspaceHistoryState {
  if (!isWorkspacePayload(value) && !isWorkspaceState(value)) {
    return createEmptyAgentWorkspaceHistory()
  }
  return normalizeWorkspaceState(value)
}

function isWorkspacePayload(value: unknown): value is AgentWorkspaceHistoryPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<AgentWorkspaceHistoryPayload>
  return (
    (payload.version === 2 || payload.version === 3) &&
    Array.isArray(payload.projects) &&
    Array.isArray(payload.items) &&
    typeof payload.activeProjectId === 'string'
  )
}

function isWorkspaceState(value: unknown): value is AgentWorkspaceHistoryState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<AgentWorkspaceHistoryState>
  return (
    Array.isArray(state.projects) &&
    Array.isArray(state.items) &&
    typeof state.activeProjectId === 'string'
  )
}

function normalizeWorkspaceState(value: AgentWorkspaceHistoryState): AgentWorkspaceHistoryState {
  const projects = value.projects
    .map(normalizeProject)
    .filter((project): project is AgentProject => Boolean(project))
  const normalizedProjects = projects.length
    ? projects
    : createEmptyAgentWorkspaceHistory().projects
  const projectIds = new Set(normalizedProjects.map((project) => project.id))
  const activeProjectId =
    value.activeProjectId === UNGROUPED_AGENT_PROJECT_ID || projectIds.has(value.activeProjectId)
      ? value.activeProjectId
      : normalizedProjects[0]!.id
  return {
    projects: normalizedProjects,
    activeProjectId,
    items: value.items
      .map(normalizeAiChatHistoryItem)
      .filter(
        (item): item is AiChatHistoryItem =>
          Boolean(item) &&
          (item.projectId === UNGROUPED_AGENT_PROJECT_ID || projectIds.has(item.projectId)),
      )
      .slice(0, AI_CHAT_HISTORY_LIMIT),
  }
}

function normalizeProject(value: unknown): AgentProject | null {
  if (!value || typeof value !== 'object') return null
  const project = value as Partial<AgentProject>
  if (typeof project.id !== 'string' || !project.id.trim()) return null
  const now = Date.now()
  return {
    id: project.id.trim(),
    name:
      typeof project.name === 'string' && project.name.trim()
        ? project.name.trim().slice(0, 80)
        : '未命名项目',
    workspaceRootIds: Array.isArray(project.workspaceRootIds)
      ? [
          ...new Set(
            project.workspaceRootIds.filter(
              (id): id is string => typeof id === 'string' && Boolean(id.trim()),
            ),
          ),
        ]
      : [],
    pinnedAt: Number.isFinite(project.pinnedAt) ? Number(project.pinnedAt) : null,
    createdAt: Number.isFinite(project.createdAt) ? Number(project.createdAt) : now,
    updatedAt: Number.isFinite(project.updatedAt) ? Number(project.updatedAt) : now,
  }
}

function normalizeAiChatHistoryItem(value: unknown): AiChatHistoryItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<AiChatHistoryItem>
  const messages = normalizeAiMessages(item.messages)
  if (
    typeof item.id !== 'string' ||
    !item.id.trim() ||
    typeof item.projectId !== 'string' ||
    !item.projectId.trim() ||
    messages.length === 0
  ) {
    return null
  }
  return {
    id: item.id.trim(),
    projectId: item.projectId.trim(),
    parentConversationId:
      typeof item.parentConversationId === 'string' && item.parentConversationId.trim()
        ? item.parentConversationId.trim()
        : null,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '未命名对话',
    createdAt: Number.isFinite(item.createdAt)
      ? Number(item.createdAt)
      : Number.isFinite(item.updatedAt)
        ? Number(item.updatedAt)
        : Date.now(),
    updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : Date.now(),
    messageCount: messages.length,
    provider: typeof item.provider === 'string' ? item.provider : '',
    model: typeof item.model === 'string' ? item.model : '',
    pinnedAt: Number.isFinite(item.pinnedAt) ? Number(item.pinnedAt) : null,
    messages,
  }
}

function normalizeAiMessages(value: unknown): AiChatHistoryMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((messageValue): AiChatHistoryMessage | null => {
      if (!messageValue || typeof messageValue !== 'object') return null
      const message = messageValue as Partial<AiChatHistoryMessage>
      if (
        typeof message.id !== 'string' ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        !['ask', 'edit', 'agent', 'auto'].includes(message.mode) ||
        typeof message.content !== 'string'
      ) {
        return null
      }
      return {
        id: message.id,
        role: message.role,
        mode: message.mode,
        content: message.content,
        reasoningContent:
          typeof message.reasoningContent === 'string' ? message.reasoningContent : '',
        ...(isResearchResult(message.researchResult)
          ? { researchResult: message.researchResult }
          : {}),
        ...(isCognitiveProvenance(message.cognitiveProvenance)
          ? { cognitiveProvenance: message.cognitiveProvenance }
          : {}),
        ...(isResearchCandidates(message.researchCandidates)
          ? { researchCandidates: message.researchCandidates }
          : {}),
        ...(isReviewResult(message.reviewResult) ? { reviewResult: message.reviewResult } : {}),
        ...(isLearningResult(message.learningResult)
          ? { learningResult: message.learningResult }
          : {}),
        ...(isLearningState(message.learningState) ? { learningState: message.learningState } : {}),
        ...(normalizeAgentRuntimeHistory(message.agentRuntime)
          ? { agentRuntime: normalizeAgentRuntimeHistory(message.agentRuntime) }
          : {}),
        status: message.status === 'error' ? 'error' : 'done',
      }
    })
    .filter((message): message is AiChatHistoryMessage => Boolean(message))
}

function normalizeAgentRuntimeHistory(value: unknown): AgentRuntimeViewState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<AgentRuntimeViewState>
  if (
    !['completed', 'failed', 'cancelled'].includes(state.status ?? '') ||
    !Number.isFinite(state.startedAt) ||
    !Number.isFinite(state.completedAt) ||
    !Array.isArray(state.toolCalls) ||
    !Array.isArray(state.timelineEvents)
  ) {
    return null
  }
  return {
    status: state.status as AgentRuntimeViewState['status'],
    phase:
      state.status === 'completed'
        ? 'completed'
        : state.status === 'cancelled'
          ? 'cancelled'
          : 'failed',
    detail: typeof state.detail === 'string' ? state.detail : '',
    startedAt: Number(state.startedAt),
    completedAt: Number(state.completedAt),
    rounds: Number.isFinite(state.rounds) ? Math.max(0, Number(state.rounds)) : 0,
    toolCalls: state.toolCalls.slice(0, 64),
    timelineEvents: state.timelineEvents.slice(0, 128),
    authorizationRequest: null,
    summary: typeof state.summary === 'string' ? state.summary : '',
  }
}

function isResearchResult(value: unknown): value is ResearchResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ResearchResult>
  return (
    typeof result.summary === 'string' &&
    Array.isArray(result.items) &&
    Array.isArray(result.relations) &&
    Array.isArray(result.unresolvedQuestions)
  )
}

function isCognitiveProvenance(value: unknown): value is CognitiveResultProvenance {
  if (!value || typeof value !== 'object') return false
  const provenance = value as Partial<CognitiveResultProvenance>
  return (
    typeof provenance.sessionId === 'string' &&
    typeof provenance.runId === 'string' &&
    ['research', 'review', 'learning'].includes(provenance.modeId ?? '') &&
    Number.isInteger(provenance.modeVersion) &&
    typeof provenance.outputContractId === 'string' &&
    Number.isFinite(provenance.createdAt)
  )
}

function isResearchCandidates(value: unknown): value is ResearchCandidateRef[] {
  return (
    Array.isArray(value) &&
    value.every((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false
      const item = candidate as Partial<ResearchCandidateRef>
      return (
        typeof item.itemId === 'string' &&
        typeof item.candidateId === 'string' &&
        Number.isInteger(item.version) &&
        ['pending', 'kept', 'approved', 'rejected'].includes(item.decision ?? '') &&
        ['fresh', 'stale', 'unverified'].includes(item.sourceState ?? '') &&
        typeof item.title === 'string' &&
        typeof item.content === 'string' &&
        typeof item.error === 'string'
      )
    })
  )
}

function isReviewResult(value: unknown): value is ReviewResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ReviewResult>
  return (
    typeof result.summary === 'string' &&
    Array.isArray(result.issues) &&
    result.issues.every(
      (issue) =>
        issue &&
        typeof issue === 'object' &&
        typeof issue.id === 'string' &&
        typeof issue.issueType === 'string' &&
        typeof issue.severity === 'string' &&
        typeof issue.title === 'string' &&
        typeof issue.explanation === 'string' &&
        typeof issue.affectedText === 'string' &&
        typeof issue.suggestedAction === 'string' &&
        Array.isArray(issue.sources) &&
        ['fresh', 'stale', 'unverified'].includes(issue.sourceState),
    ) &&
    Array.isArray(result.unresolvedQuestions)
  )
}

function isLearningResult(value: unknown): value is LearningTurnResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<LearningTurnResult>
  return (
    (result.phase === 'waiting_user' || result.phase === 'completed') &&
    isLearningFeedback(result.feedback) &&
    isLearningUnderstandingState(result.understandingState) &&
    typeof result.evidence === 'string' &&
    Boolean(
      result.nextPrompt &&
      typeof result.nextPrompt === 'object' &&
      [
        'question',
        'guided_question',
        'hint',
        'counterexample',
        'transfer_question',
        'none',
      ].includes(result.nextPrompt.kind) &&
      typeof result.nextPrompt.content === 'string' &&
      Number.isInteger(result.nextPrompt.hintLevel) &&
      result.nextPrompt.hintLevel >= 0 &&
      result.nextPrompt.hintLevel <= 3,
    ) &&
    (result.candidateUnderstanding === null ||
      Boolean(
        result.candidateUnderstanding &&
        typeof result.candidateUnderstanding.title === 'string' &&
        typeof result.candidateUnderstanding.content === 'string' &&
        Number.isFinite(result.candidateUnderstanding.confidence),
      ))
  )
}

function isLearningState(value: unknown): value is LearningSessionState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<LearningSessionState>
  return (
    state.version === 1 &&
    typeof state.topic === 'string' &&
    typeof state.currentPrompt === 'string' &&
    ['question', 'guided_question', 'hint', 'counterexample', 'transfer_question', 'none'].includes(
      state.promptKind ?? '',
    ) &&
    Number.isInteger(state.hintLevel) &&
    Number(state.hintLevel) >= 0 &&
    Number(state.hintLevel) <= 3 &&
    Array.isArray(state.attempts) &&
    state.attempts.every(
      (attempt) =>
        attempt &&
        typeof attempt === 'object' &&
        typeof attempt.id === 'string' &&
        typeof attempt.response === 'string' &&
        isLearningFeedback(attempt.feedback) &&
        isLearningUnderstandingState(attempt.understandingState) &&
        typeof attempt.evidence === 'string' &&
        Number.isFinite(attempt.createdAt),
    ) &&
    isLearningUnderstandingState(state.understandingState) &&
    ['await_attempt', 'continue', 'complete', 'needs_review'].includes(state.nextStep ?? '')
  )
}

function isLearningFeedback(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const feedback = value as LearningTurnResult['feedback']
  return (
    isStringArray(feedback.correctPoints) &&
    isStringArray(feedback.omissions) &&
    isStringArray(feedback.misconceptions)
  )
}

function isLearningUnderstandingState(value: unknown): boolean {
  return ['not_assessed', 'partial', 'misconception', 'demonstrated', 'needs_review'].includes(
    typeof value === 'string' ? value : '',
  )
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
