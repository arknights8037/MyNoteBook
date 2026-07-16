import { beforeEach, describe, expect, it } from 'vitest'

import {
  AI_CHAT_HISTORY_LIMIT,
  DEFAULT_AGENT_PROJECT_ID,
  normalizeAgentWorkspaceHistory,
  purgeLegacyAgentHistoryStorage,
  UNGROUPED_AGENT_PROJECT_ID,
} from './aiChatHistory'

describe('Agent workspace history model', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('normalizes the versioned project and conversation state', () => {
    const state = normalizeAgentWorkspaceHistory({
      version: 2,
      projects: [
        {
          id: 'project-1',
          name: 'Research',
          workspaceRootIds: ['group-1', 'group-1'],
          pinnedAt: 30,
          createdAt: 10,
          updatedAt: 20,
        },
      ],
      activeProjectId: 'project-1',
      items: [historyItem('history-1', 'project-1')],
    })

    expect(state.activeProjectId).toBe('project-1')
    expect(state.projects[0]?.workspaceRootIds).toEqual(['group-1'])
    expect(state.projects[0]?.pinnedAt).toBe(30)
    expect(state.items[0]).toMatchObject({
      id: 'history-1',
      projectId: 'project-1',
      messageCount: 1,
    })
  })

  it('rejects unversioned legacy arrays instead of migrating them', () => {
    const state = normalizeAgentWorkspaceHistory([historyItem('legacy', 'project-1')])

    expect(state.activeProjectId).toBe(DEFAULT_AGENT_PROJECT_ID)
    expect(state.items).toEqual([])
  })

  it('purges both legacy local history keys', () => {
    localStorage.setItem('my-notebook:ai-chat-history', 'legacy')
    localStorage.setItem('my-notebook:agent-workspace-history:v2', 'legacy-v2')

    purgeLegacyAgentHistoryStorage()

    expect(localStorage.length).toBe(0)
  })

  it('limits conversations and removes records for unknown projects', () => {
    const state = normalizeAgentWorkspaceHistory({
      version: 2,
      projects: [project('project-1')],
      activeProjectId: 'project-1',
      items: [
        ...Array.from({ length: AI_CHAT_HISTORY_LIMIT + 5 }, (_, index) =>
          historyItem(`history-${index}`, 'project-1'),
        ),
        historyItem('orphan', 'missing-project'),
      ],
    })

    expect(state.items).toHaveLength(AI_CHAT_HISTORY_LIMIT)
    expect(state.items.some((item) => item.id === 'orphan')).toBe(false)
  })

  it('preserves ungrouped tasks without creating a synthetic project', () => {
    const state = normalizeAgentWorkspaceHistory({
      version: 2,
      projects: [project('project-1')],
      activeProjectId: UNGROUPED_AGENT_PROJECT_ID,
      items: [historyItem('loose-task', UNGROUPED_AGENT_PROJECT_ID)],
    })

    expect(state.activeProjectId).toBe(UNGROUPED_AGENT_PROJECT_ID)
    expect(state.projects).toHaveLength(1)
    expect(state.items[0]?.projectId).toBe(UNGROUPED_AGENT_PROJECT_ID)
  })
})

function project(id: string) {
  return {
    id,
    name: 'Project',
    workspaceRootIds: [],
    pinnedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function historyItem(id: string, projectId: string) {
  return {
    id,
    projectId,
    title: 'Conversation',
    updatedAt: 1,
    messageCount: 1,
    provider: 'openai',
    model: 'gpt',
    pinnedAt: null,
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        mode: 'agent',
        content: 'work',
        status: 'done',
      },
    ],
  }
}
