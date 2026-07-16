import type { AiChatMode, AiChatRole, AiChatStatus } from './aiChatMode'

export interface AiChatHistoryMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  reasoningContent?: string
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
  title: string
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
  version: 2
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
    payload.version === 2 &&
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
      ? [...new Set(project.workspaceRootIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))]
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
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '未命名对话',
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
        reasoningContent: typeof message.reasoningContent === 'string' ? message.reasoningContent : '',
        status: message.status === 'error' ? 'error' : 'done',
      }
    })
    .filter((message): message is AiChatHistoryMessage => Boolean(message))
}
