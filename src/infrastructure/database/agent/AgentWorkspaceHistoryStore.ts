import type { AgentWorkspaceHistoryState } from '@/models/ai/aiChatHistory'
import { normalizeAgentWorkspaceHistory } from '@/models/ai/aiChatHistory'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'
import { parseJsonStrict } from '@/repositories/shared/jsonCodec'

import { getDatabase } from '@/infrastructure/database/shared/connection'

interface AgentWorkspaceStateRow extends Record<string, unknown> {
  state_json: string
}

export class SqliteAgentWorkspaceHistoryStore implements AgentWorkspaceHistoryStore {
  constructor(private readonly getClient: () => Promise<SqlClient> = getDatabase) {}

  async load(): Promise<AgentWorkspaceHistoryState | null> {
    const rows = await (
      await this.getClient()
    ).select<AgentWorkspaceStateRow>(
      `SELECT state_json FROM agent_workspace_state WHERE id = 'current' LIMIT 1`,
    )
    const row = rows[0]
    if (!row) return null
    return normalizeAgentWorkspaceHistory(
      parseJsonStrict<unknown>(row.state_json, '工作区历史状态'),
    )
  }

  async save(state: AgentWorkspaceHistoryState): Promise<void> {
    const normalized = normalizeAgentWorkspaceHistory(state)
    await (
      await this.getClient()
    ).execute(
      `INSERT INTO agent_workspace_state (id, state_json, updated_at)
       VALUES ('current', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
      [JSON.stringify({ version: 3, ...normalized }), Date.now()],
    )
  }
}

export function createAgentWorkspaceHistoryStore(): AgentWorkspaceHistoryStore {
  return new SqliteAgentWorkspaceHistoryStore()
}
