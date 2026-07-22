import type { AgentWorkspaceHistoryState } from '@/models/ai/aiChatHistory'

export interface AgentWorkspaceHistoryStore {
  load(): Promise<AgentWorkspaceHistoryState | null>
  save(state: AgentWorkspaceHistoryState): Promise<void>
}
