import { computed, ref, type Ref } from 'vue'

import type { AgentProject, AiChatHistoryMessage, AiChatHistoryItem } from '@/models/ai/aiChatHistory'
import {
  createEmptyAgentWorkspaceHistory,
  purgeLegacyAgentHistoryStorage,
  UNGROUPED_AGENT_PROJECT_ID,
} from '@/models/ai/aiChatHistory'
import type { AiSettings } from '@/models/ai/ai'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'
import {
  createAiHistoryPersistence,
  normalizeHistoryTitle,
  sortByPinnedAndRecent,
} from './aiHistory/useAiHistoryPersistence'
import { createAiHistoryProjects } from './aiHistory/useAiHistoryProjects'

const transientHistoryStore: AgentWorkspaceHistoryStore = {
  load: async () => null,
  save: async () => undefined,
}

export function useAiChatHistory(
  messages: Ref<AiChatHistoryMessage[]>,
  settings: Ref<AiSettings>,
  createId: () => string,
  store: AgentWorkspaceHistoryStore = transientHistoryStore,
) {
  purgeLegacyAgentHistoryStorage()
  const initial = createEmptyAgentWorkspaceHistory()
  const history = ref<AiChatHistoryItem[]>(initial.items)
  const projects = ref<AgentProject[]>(initial.projects)
  const activeProjectId = ref(initial.activeProjectId)
  const currentId = ref<string | null>(null)

  const projectHistory = computed(() =>
    sortByPinnedAndRecent(history.value.filter((item) => item.projectId === activeProjectId.value)),
  )
  const orderedHistory = computed(() => sortByPinnedAndRecent(history.value))
  const orderedProjects = computed(() => sortByPinnedAndRecent(projects.value))
  const activeProject = computed(
    () => projects.value.find((project) => project.id === activeProjectId.value) ?? null,
  )

  const sharedState = { history, projects, activeProjectId, currentId, messages, settings, createId }

  const persistence = createAiHistoryPersistence(sharedState, store, (rootId, name) =>
    projectActions.ensureDefaultWorkspace(rootId, name),
  )

  const projectActions = createAiHistoryProjects(sharedState, persistence)

  // --- History CRUD ---

  function select(historyId: string): AiChatHistoryItem | null {
    const item = history.value.find((candidate) => candidate.id === historyId) ?? null
    if (item) {
      activeProjectId.value = item.projectId
      currentId.value = item.id
      persistence.persist()
    }
    return item
  }

  function remove(historyId: string): boolean {
    const existed = history.value.some((item) => item.id === historyId)
    history.value = history.value.filter((item) => item.id !== historyId)
    if (currentId.value === historyId) currentId.value = null
    persistence.persist()
    return existed
  }

  function resetCurrent(): void {
    currentId.value = null
  }

  function toggleHistoryPin(historyId: string): boolean {
    const item = history.value.find((candidate) => candidate.id === historyId)
    if (!item) return false
    history.value = history.value.map((candidate) =>
      candidate.id === historyId
        ? { ...candidate, pinnedAt: candidate.pinnedAt === null ? Date.now() : null }
        : candidate,
    )
    persistence.persist()
    return true
  }

  function moveHistoryToProject(historyId: string, projectId: string): boolean {
    if (!projects.value.some((project) => project.id === projectId)) return false
    const item = history.value.find((candidate) => candidate.id === historyId)
    if (!item || item.projectId === projectId) return false
    history.value = history.value.map((candidate) =>
      candidate.id === historyId ? { ...candidate, projectId } : candidate,
    )
    if (currentId.value === historyId) activeProjectId.value = projectId
    persistence.persist()
    return true
  }

  function needsTitle(historyId: string): boolean {
    return (
      !history.value.some((item) => item.id === historyId) &&
      !persistence.getPendingTitles().has(historyId)
    )
  }

  function setTitle(historyId: string, title: string): boolean {
    const normalized = normalizeHistoryTitle(title)
    if (!normalized) return false
    const existing = history.value.find((item) => item.id === historyId)
    if (!existing) {
      persistence.getPendingTitles().set(historyId, normalized)
      return true
    }
    history.value = history.value.map((item) =>
      item.id === historyId ? { ...item, title: normalized } : item,
    )
    persistence.persist()
    return true
  }

  function saveDetachedTask(input: {
    id: string
    projectId?: string
    parentConversationId?: string | null
    title: string
    messages: AiChatHistoryMessage[]
  }): boolean {
    const persistableMessages = input.messages
      .filter((message) => message.content.trim() || message.reasoningContent?.trim())
      .map((message) => ({
        ...message,
        status: message.status === 'error' ? ('error' as const) : ('done' as const),
      }))
    if (!input.id.trim() || persistableMessages.length === 0) return false
    const projectId = projects.value.some((project) => project.id === input.projectId)
      ? input.projectId!
      : UNGROUPED_AGENT_PROJECT_ID
    const existing = history.value.find((item) => item.id === input.id)
    const now = Date.now()
    const record: AiChatHistoryItem = {
      id: input.id,
      projectId,
      parentConversationId:
        existing?.parentConversationId ?? input.parentConversationId?.trim() ?? null,
      title: normalizeHistoryTitle(input.title) || '外部 Agent 任务',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messageCount: persistableMessages.length,
      provider: settings.value.provider,
      model: settings.value.model,
      pinnedAt: existing?.pinnedAt ?? null,
      messages: persistableMessages,
    }
    history.value = existing
      ? history.value.map((item) => (item.id === input.id ? record : item))
      : [record, ...history.value].slice(0, 100)
    persistence.persist()
    return true
  }

  function migrateLeakedTask(input: {
    id: string
    title: string
    prompt: string
  }): { sourceHistoryId: string; messageIds: string[] } | null {
    if (history.value.some((item) => item.id === input.id)) return null
    for (const source of history.value) {
      const userIndex = source.messages.findIndex(
        (message, index) =>
          message.role === 'user' &&
          message.content === input.prompt &&
          source.messages[index + 1]?.role === 'assistant',
      )
      if (userIndex < 0) continue
      const detachedMessages = source.messages.slice(userIndex, userIndex + 2)
      const messageIds = detachedMessages.map((message) => message.id)
      const remainingMessages = source.messages.filter(
        (message) => !messageIds.includes(message.id),
      )
      history.value = history.value
        .map((item) =>
          item.id === source.id
            ? { ...item, messages: remainingMessages, messageCount: remainingMessages.length }
            : item,
        )
        .filter((item) => item.messages.length > 0)
      saveDetachedTask({
        id: input.id,
        title: input.title,
        messages: detachedMessages,
      })
      return { sourceHistoryId: source.id, messageIds }
    }
    return null
  }

  return {
    history,
    orderedHistory,
    projectHistory,
    projects,
    orderedProjects,
    activeProjectId,
    activeProject,
    currentId,
    hydrate: persistence.hydrate,
    scheduleSave: persistence.scheduleSave,
    flush: persistence.flush,
    select,
    remove,
    resetCurrent,
    startTask: projectActions.startTask,
    selectProject: projectActions.selectProject,
    createProject: projectActions.createProject,
    removeProject: projectActions.removeProject,
    toggleProjectPin: projectActions.toggleProjectPin,
    toggleHistoryPin,
    moveHistoryToProject,
    saveDetachedTask,
    migrateLeakedTask,
    renameProject: projectActions.renameProject,
    updateWorkspace: projectActions.updateWorkspace,
    ensureDefaultWorkspace: projectActions.ensureDefaultWorkspace,
    needsTitle,
    setTitle,
  }
}
