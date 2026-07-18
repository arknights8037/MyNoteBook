import { computed, ref, type Ref } from 'vue'

import type { AgentProject, AiChatHistoryMessage, AiChatHistoryItem } from '@/models/aiChatHistory'
import {
  createEmptyAgentWorkspaceHistory,
  normalizeAgentWorkspaceHistory,
  purgeLegacyAgentHistoryStorage,
  UNGROUPED_AGENT_PROJECT_ID,
} from '@/models/aiChatHistory'
import type { AiSettings } from '@/models/ai'
import {
  createAgentWorkspaceHistoryStore,
  type AgentWorkspaceHistoryStore,
} from '@/infrastructure/database/AgentWorkspaceHistoryStore'

export function useAiChatHistory(
  messages: Ref<AiChatHistoryMessage[]>,
  settings: Ref<AiSettings>,
  createId: () => string,
  store: AgentWorkspaceHistoryStore = createAgentWorkspaceHistoryStore(),
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
  let saveTimer: number | null = null
  let hydrated = false
  let dirtyBeforeHydration = false
  let saveChain = Promise.resolve()
  let pendingDefaultWorkspace: { rootId: string; name: string } | null = null
  const pendingTitles = new Map<string, string>()

  function persist(): void {
    const state = normalizeAgentWorkspaceHistory({
      projects: projects.value,
      activeProjectId: activeProjectId.value,
      items: history.value,
    })
    if (!hydrated) {
      dirtyBeforeHydration = true
      return
    }
    saveChain = saveChain.then(() => store.save(state)).catch(() => undefined)
  }

  async function hydrate(): Promise<void> {
    if (hydrated) return
    try {
      const persisted = await store.load()
      if (persisted && !dirtyBeforeHydration) {
        const normalized = normalizeAgentWorkspaceHistory(persisted)
        projects.value = normalized.projects
        activeProjectId.value = normalized.activeProjectId
        history.value = normalized.items
      }
    } catch {
      // Database preparation reports errors elsewhere; keep the in-memory session usable.
    } finally {
      hydrated = true
      const pending = pendingDefaultWorkspace
      pendingDefaultWorkspace = null
      if (pending) ensureDefaultWorkspace(pending.rootId, pending.name)
      else if (dirtyBeforeHydration) persist()
    }
  }

  function scheduleSave(): void {
    if (saveTimer !== null) globalThis.clearTimeout(saveTimer)
    saveTimer = globalThis.setTimeout(flush, 500)
  }

  function flush(): void {
    if (saveTimer !== null) globalThis.clearTimeout(saveTimer)
    saveTimer = null
    const persistableMessages = messages.value
      .filter((message) => message.content.trim() || message.reasoningContent?.trim())
      .map((message) => ({
        ...message,
        status: message.status === 'error' ? ('error' as const) : ('done' as const),
      }))
    if (persistableMessages.length === 0) return

    const id = currentId.value ?? createId()
    currentId.value = id
    const existing = history.value.find((item) => item.id === id) ?? null
    if (existing && messagesEqual(existing.messages, persistableMessages)) return
    const now = Date.now()
    const record: AiChatHistoryItem = {
      id,
      projectId: activeProjectId.value,
      parentConversationId: existing?.parentConversationId ?? null,
      title: pendingTitles.get(id) ?? existing?.title ?? createHistoryTitle(persistableMessages),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messageCount: persistableMessages.length,
      provider: settings.value.provider,
      model: settings.value.model,
      pinnedAt: existing?.pinnedAt ?? null,
      messages: persistableMessages,
    }
    pendingTitles.delete(id)
    history.value = existing
      ? history.value.map((item) => (item.id === id ? record : item))
      : [record, ...history.value].slice(0, 100)
    persist()
  }

  function needsTitle(historyId: string): boolean {
    return !history.value.some((item) => item.id === historyId) && !pendingTitles.has(historyId)
  }

  function setTitle(historyId: string, title: string): boolean {
    const normalized = normalizeHistoryTitle(title)
    if (!normalized) return false
    const existing = history.value.find((item) => item.id === historyId)
    if (!existing) {
      pendingTitles.set(historyId, normalized)
      return true
    }
    history.value = history.value.map((item) =>
      item.id === historyId ? { ...item, title: normalized } : item,
    )
    persist()
    return true
  }

  function select(historyId: string): AiChatHistoryItem | null {
    const item = history.value.find((candidate) => candidate.id === historyId) ?? null
    if (item) {
      activeProjectId.value = item.projectId
      currentId.value = item.id
      persist()
    }
    return item
  }

  function remove(historyId: string): boolean {
    const existed = history.value.some((item) => item.id === historyId)
    history.value = history.value.filter((item) => item.id !== historyId)
    if (currentId.value === historyId) currentId.value = null
    persist()
    return existed
  }

  function resetCurrent(): void {
    currentId.value = null
  }

  function startTask(projectId: string | null): boolean {
    if (projectId === null) {
      activeProjectId.value = UNGROUPED_AGENT_PROJECT_ID
      currentId.value = null
      persist()
      return true
    }
    return Boolean(selectProject(projectId))
  }

  function selectProject(projectId: string): AgentProject | null {
    const project = projects.value.find((candidate) => candidate.id === projectId) ?? null
    if (!project) return null
    activeProjectId.value = project.id
    currentId.value = null
    persist()
    return project
  }

  function createProject(input?: { name?: string; workspaceRootIds?: string[] }): AgentProject {
    const now = Date.now()
    const project: AgentProject = {
      id: createId(),
      name: input?.name?.trim().slice(0, 80) || `新项目 ${projects.value.length + 1}`,
      workspaceRootIds: [...new Set(input?.workspaceRootIds?.filter(Boolean) ?? [])],
      pinnedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    projects.value = [...projects.value, project]
    activeProjectId.value = project.id
    currentId.value = null
    persist()
    return project
  }

  function toggleProjectPin(projectId: string): boolean {
    return updateProject(projectId, (project) => ({
      ...project,
      pinnedAt: project.pinnedAt === null ? Date.now() : null,
    }))
  }

  function toggleHistoryPin(historyId: string): boolean {
    const item = history.value.find((candidate) => candidate.id === historyId)
    if (!item) return false
    history.value = history.value.map((candidate) =>
      candidate.id === historyId
        ? { ...candidate, pinnedAt: candidate.pinnedAt === null ? Date.now() : null }
        : candidate,
    )
    persist()
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
    persist()
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
    persist()
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

  function renameProject(projectId: string, name: string): boolean {
    const normalized = name.trim().slice(0, 80)
    if (!normalized) return false
    return updateProject(projectId, (project) => ({ ...project, name: normalized }))
  }

  function updateWorkspace(projectId: string, workspaceRootIds: string[]): boolean {
    const normalized = [...new Set(workspaceRootIds.filter(Boolean))]
    return updateProject(projectId, (project) => ({
      ...project,
      workspaceRootIds: normalized,
    }))
  }

  function ensureDefaultWorkspace(rootId: string, name = 'Agent MVP'): void {
    if (!hydrated) {
      pendingDefaultWorkspace = { rootId, name }
      return
    }
    const project = projects.value[0]
    if (!project || project.workspaceRootIds.length > 0 || !rootId) return
    projects.value = [
      { ...project, name, workspaceRootIds: [rootId], updatedAt: Date.now() },
      ...projects.value.slice(1),
    ]
    persist()
  }

  function updateProject(
    projectId: string,
    updater: (project: AgentProject) => AgentProject,
  ): boolean {
    const index = projects.value.findIndex((project) => project.id === projectId)
    const project = projects.value[index]
    if (!project) return false
    const updated = { ...updater(project), updatedAt: Date.now() }
    projects.value = projects.value.map((item, itemIndex) => (itemIndex === index ? updated : item))
    persist()
    return true
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
    hydrate,
    scheduleSave,
    flush,
    select,
    remove,
    resetCurrent,
    startTask,
    selectProject,
    createProject,
    toggleProjectPin,
    toggleHistoryPin,
    moveHistoryToProject,
    saveDetachedTask,
    migrateLeakedTask,
    renameProject,
    updateWorkspace,
    ensureDefaultWorkspace,
    needsTitle,
    setTitle,
  }
}

function sortByPinnedAndRecent<
  T extends { pinnedAt: number | null; createdAt?: number; updatedAt: number },
>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.pinnedAt !== null || right.pinnedAt !== null) {
      if (left.pinnedAt === null) return 1
      if (right.pinnedAt === null) return -1
      return right.pinnedAt - left.pinnedAt
    }
    return (right.createdAt ?? right.updatedAt) - (left.createdAt ?? left.updatedAt)
  })
}

function messagesEqual(left: AiChatHistoryMessage[], right: AiChatHistoryMessage[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeHistoryTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 36)
}

function createHistoryTitle(messages: AiChatHistoryMessage[]): string {
  const source =
    messages.find((message) => message.role === 'user')?.content ??
    messages.find((message) => message.content.trim())?.content ??
    messages[0]?.content ??
    ''
  return normalizeHistoryTitle(source) || '未命名对话'
}
