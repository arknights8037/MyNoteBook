import { describe, expect, it } from 'vitest'

import { createEmptyAgentWorkspaceHistory } from '@/models/aiChatHistory'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/SqlClient'

import { SqliteAgentWorkspaceHistoryStore } from './AgentWorkspaceHistoryStore'

describe('SqliteAgentWorkspaceHistoryStore', () => {
  it('round-trips the versioned project, workspace and conversation snapshot', async () => {
    const client = new MemoryWorkspaceClient()
    const store = new SqliteAgentWorkspaceHistoryStore(async () => client)
    const state = createEmptyAgentWorkspaceHistory()
    state.projects[0]!.workspaceRootIds = ['group-agent-mvp']
    state.items = [
      {
        id: 'conversation-1',
        projectId: state.activeProjectId,
        title: 'Agent task',
        updatedAt: 20,
        messageCount: 1,
        provider: 'openai',
        model: 'gpt',
        pinnedAt: 30,
        messages: [
          {
            id: 'message-1',
            role: 'user',
            mode: 'agent',
            content: 'Review the runtime',
            status: 'done',
          },
        ],
      },
    ]

    await store.save(state)

    await expect(store.load()).resolves.toMatchObject({
      projects: [{ workspaceRootIds: ['group-agent-mvp'] }],
      items: [{ id: 'conversation-1', messageCount: 1, pinnedAt: 30 }],
    })
  })
})

class MemoryWorkspaceClient implements SqlClient {
  private stateJson: string | null = null

  async execute(_sql: string, bindValues: SqlValue[] = []): Promise<SqlExecuteResult> {
    this.stateJson = String(bindValues[0] ?? '')
    return { rowsAffected: 1, lastInsertId: 0 }
  }

  async select<T extends Record<string, unknown>>(): Promise<T[]> {
    return this.stateJson ? ([{ state_json: this.stateJson }] as T[]) : []
  }
}
