import type { Ref } from 'vue'

import type { AgentProject, AiChatHistoryItem, AiChatHistoryMessage } from '@/models/ai/aiChatHistory'
import { normalizeAgentWorkspaceHistory } from '@/models/ai/aiChatHistory'
import type { AiSettings } from '@/models/ai/ai'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'

export interface AiHistoryPersistenceState {
  history: Ref<AiChatHistoryItem[]>
  projects: Ref<AgentProject[]>
  activeProjectId: Ref<string>
  currentId: Ref<string | null>
  messages: Ref<AiChatHistoryMessage[]>
  settings: Ref<AiSettings>
  createId: () => string
}

export interface AiHistoryPersistence {
  hydrate: () => Promise<void>
  persist: () => void
  scheduleSave: () => void
  flush: () => void
  isHydrated: () => boolean
  setPendingDefaultWorkspace: (rootId: string, name: string) => void
  getPendingTitles: () => Map<string, string>
}

export function createAiHistoryPersistence(
  state: AiHistoryPersistenceState,
  store: AgentWorkspaceHistoryStore,
  onEnsureDefaultWorkspace: (rootId: string, name: string) => void,
): AiHistoryPersistence {
  let saveTimer: number | null = null
  let hydrated = false
  let dirtyBeforeHydration = false
  let saveChain = Promise.resolve()
  let pendingDefaultWorkspace: { rootId: string; name: string } | null = null
  const pendingTitles = new Map<string, string>()

  function persist(): void {
    const normalized = normalizeAgentWorkspaceHistory({
      projects: state.projects.value,
      activeProjectId: state.activeProjectId.value,
      items: state.history.value,
    })
    if (!hydrated) {
      dirtyBeforeHydration = true
      return
    }
    saveChain = saveChain.then(() => store.save(normalized)).catch(() => undefined)
  }

  async function hydrate(): Promise<void> {
    if (hydrated) return
    try {
      const persisted = await store.load()
      if (persisted && !dirtyBeforeHydration) {
        const normalized = normalizeAgentWorkspaceHistory(persisted)
        state.projects.value = normalized.projects
        state.activeProjectId.value = normalized.activeProjectId
        state.history.value = normalized.items
      }
    } catch {
      // Database preparation reports errors elsewhere; keep the in-memory session usable.
    } finally {
      hydrated = true
      const pending = pendingDefaultWorkspace
      pendingDefaultWorkspace = null
      if (pending) onEnsureDefaultWorkspace(pending.rootId, pending.name)
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
    const persistableMessages = state.messages.value
      .filter((message) => message.content.trim() || message.reasoningContent?.trim())
      .map((message) => ({
        ...message,
        status: message.status === 'error' ? ('error' as const) : ('done' as const),
      }))
    if (persistableMessages.length === 0) return

    const id = state.currentId.value ?? state.createId()
    state.currentId.value = id
    const existing = state.history.value.find((item) => item.id === id) ?? null
    if (existing && messagesEqual(existing.messages, persistableMessages)) return
    const now = Date.now()
    const record: AiChatHistoryItem = {
      id,
      projectId: state.activeProjectId.value,
      parentConversationId: existing?.parentConversationId ?? null,
      title: pendingTitles.get(id) ?? existing?.title ?? createHistoryTitle(persistableMessages),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messageCount: persistableMessages.length,
      provider: state.settings.value.provider,
      model: state.settings.value.model,
      pinnedAt: existing?.pinnedAt ?? null,
      messages: persistableMessages,
    }
    pendingTitles.delete(id)
    state.history.value = existing
      ? state.history.value.map((item) => (item.id === id ? record : item))
      : [record, ...state.history.value].slice(0, 100)
    persist()
  }

  return {
    hydrate,
    persist,
    scheduleSave,
    flush,
    isHydrated: () => hydrated,
    setPendingDefaultWorkspace: (rootId, name) => {
      pendingDefaultWorkspace = { rootId, name }
    },
    getPendingTitles: () => pendingTitles,
  }
}

// --- Shared helpers ---

export function sortByPinnedAndRecent<
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

export function messagesEqual(left: AiChatHistoryMessage[], right: AiChatHistoryMessage[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function normalizeHistoryTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 36)
}

export function createHistoryTitle(messages: AiChatHistoryMessage[]): string {
  const source =
    messages.find((message) => message.role === 'user')?.content ??
    messages.find((message) => message.content.trim())?.content ??
    messages[0]?.content ??
    ''
  return normalizeHistoryTitle(source) || '未命名对话'
}
