import { computed, getCurrentScope, onScopeDispose, ref, shallowReactive, watch, type Ref } from 'vue'

import { useAiChatHistory } from './useAiChatHistory'
import type { AiSettings } from '@/models/ai/ai'
import type { AiChatHistoryMessage } from '@/models/ai/aiChatHistory'
import type { AiChatMode } from '@/models/ai/aiChatMode'
import type { KnowledgeSource } from '@/models/knowledge/knowledgeRetrieval'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'

export interface AiConversationMessage extends AiChatHistoryMessage {
  sources?: KnowledgeSource[]
}

export interface AiConversationOptions {
  settings: Ref<AiSettings>
  mode: Ref<AiChatMode>
  error: Ref<string>
  isRunning: Readonly<Ref<boolean>>
  createId: () => string
  stop?: (conversationId?: string | null) => void
  notify?: (message: string) => void
  historyStore?: AgentWorkspaceHistoryStore
  generateTitle?: (prompt: string, settings: AiSettings) => Promise<string>
  persistHistory?: Readonly<Ref<boolean>>
}

export function useAiConversation(options: AiConversationOptions) {
  const messages = ref<AiConversationMessage[]>([])
  const prompt = ref('')
  const historyState = useAiChatHistory(
    messages,
    options.settings,
    options.createId,
    options.historyStore,
  )
  void historyState.hydrate()
  const historyPersistenceEnabled = () => options.persistHistory?.value !== false
  const stopHistoryWatch = watch(
    messages,
    () => {
      if (historyPersistenceEnabled()) historyState.scheduleSave()
    },
    { deep: true },
  )
  const stopHistoryPersistenceWatch = options.persistHistory
    ? watch(options.persistHistory, (enabled, wasEnabled) => {
        if (enabled && !wasEnabled && messages.value.length > 0) historyState.scheduleSave()
      })
    : null
  const requestedTitleIds = new Set<string>()
  const activeDraft = ref<{ id: string; projectId: string; createdAt: number } | null>(null)
  const visibleHistory = computed<AiChatHistoryItem[]>(() => {
    const draft = activeDraft.value
    if (!draft || historyState.orderedHistory.value.some((item) => item.id === draft.id)) {
      return historyState.orderedHistory.value
    }
    return [
      {
        id: draft.id,
        projectId: draft.projectId,
        title: '新对话',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
        messageCount: 0,
        provider: options.settings.value.provider,
        model: options.settings.value.model,
        pinnedAt: null,
        messages: [],
        transient: true,
      },
      ...historyState.orderedHistory.value,
    ]
  })
  const visibleProjectHistory = computed(() =>
    visibleHistory.value.filter((item) => item.projectId === historyState.activeProjectId.value),
  )
  const runSessions = shallowReactive(
    new Map<
      string,
      {
        projectId: string
        mode: Ref<AiChatMode>
        prompt: Ref<string>
        messages: Ref<AiConversationMessage[]>
        error: Ref<string>
        stopWatch: () => void
      }
    >(),
  )

  function clear(): void {
    if (runSessions.has(historyState.currentId.value ?? '')) {
      options.stop?.(historyState.currentId.value)
    }
    historyState.resetCurrent()
    activeDraft.value = null
    messages.value = []
    options.error.value = ''
  }

  function forkAtMessage(messageId: string): boolean {
    if (isCurrentConversationRunning()) return false
    const messageIndex = findMessageIndex(messageId)
    if (messageIndex < 0) return false

    historyState.resetCurrent()
    messages.value = messages.value.slice(0, messageIndex + 1)
    options.error.value = ''
    options.notify?.('已从此处创建对话分支')
    return true
  }

  function editMessage(messageId: string): boolean {
    if (isCurrentConversationRunning()) return false
    const messageIndex = findMessageIndex(messageId)
    const message = messages.value[messageIndex]
    if (!message) return false

    restoreMessageForEditing(message, messageIndex)
    options.notify?.('已载入该条对话，可修改后重新发送')
    return true
  }

  function prepareRetry(messageId: string): boolean {
    if (isCurrentConversationRunning()) return false
    const assistantIndex = findMessageIndex(messageId)
    if (assistantIndex < 1) return false
    const userIndex = messages.value
      .slice(0, assistantIndex)
      .findLastIndex((message) => message.role === 'user')
    const userMessage = messages.value[userIndex]
    if (!userMessage) return false

    restoreMessageForEditing(userMessage, userIndex)
    return true
  }

  function selectHistory(historyId: string): boolean {
    historyState.flush()
    if (activeDraft.value?.id === historyId) {
      historyState.activeProjectId.value = activeDraft.value.projectId
      historyState.currentId.value = historyId
      messages.value = []
      prompt.value = ''
      options.error.value = ''
      return true
    }
    const historyItem = historyState.select(historyId)
    if (!historyItem) return false

    const runSession = runSessions.get(historyId)
    activeDraft.value = null
    messages.value = (runSession?.messages.value ?? historyItem.messages).map((message) => ({
      ...message,
    }))
    prompt.value = ''
    options.error.value = runSession?.error.value ?? ''
    options.mode.value = runSession?.mode.value ?? messages.value.at(-1)?.mode ?? 'agent'
    return true
  }

  function deleteHistory(historyId: string): boolean {
    if (activeDraft.value?.id === historyId) {
      activeDraft.value = null
      historyState.resetCurrent()
      messages.value = []
      return true
    }
    if (runSessions.has(historyId)) {
      options.notify?.('请先停止该任务，再删除聊天记录')
      return false
    }
    if (historyState.currentId.value === historyId) {
      messages.value = []
      options.error.value = ''
    }
    const removed = historyState.remove(historyId)
    if (removed) options.notify?.('聊天记录已删除')
    return removed
  }

  function selectProject(projectId: string): boolean {
    historyState.flush()
    const project = historyState.selectProject(projectId)
    if (!project) return false
    messages.value = []
    activeDraft.value = null
    prompt.value = ''
    options.error.value = ''
    return true
  }

  function createProject(input?: { name?: string; workspaceRootIds?: string[] }): void {
    historyState.flush()
    const project = historyState.createProject(input)
    messages.value = []
    activeDraft.value = null
    prompt.value = ''
    options.error.value = ''
    options.notify?.(`项目“${project.name}”已创建`)
  }

  function deleteProject(projectId: string): boolean {
    if ([...runSessions.values()].some((session) => session.projectId === projectId)) {
      options.notify?.('项目中仍有运行中的任务，请先停止后再删除')
      return false
    }
    historyState.flush()
    const project = historyState.projects.value.find((candidate) => candidate.id === projectId)
    const deletingActiveProject = historyState.activeProjectId.value === projectId
    if (!project || !historyState.removeProject(projectId)) return false
    if (deletingActiveProject) {
      messages.value = []
      prompt.value = ''
      options.error.value = ''
    }
    if (activeDraft.value?.projectId === projectId) activeDraft.value = null
    options.notify?.(`项目“${project.name}”及其中的对话已删除`)
    return true
  }

  function startTask(projectId: string | null): boolean {
    historyState.flush()
    if (!historyState.startTask(projectId)) return false
    const candidateId = options.createId()
    const draftId =
      historyState.history.value.some((item) => item.id === candidateId) ||
      runSessions.has(candidateId)
      ? `${candidateId}:draft:${Date.now()}`
      : candidateId
    activeDraft.value = {
      id: draftId,
      projectId: historyState.activeProjectId.value,
      createdAt: Date.now(),
    }
    historyState.currentId.value = draftId
    messages.value = []
    prompt.value = ''
    options.error.value = ''
    return true
  }

  function moveHistoryToProject(historyId: string, projectId: string): boolean {
    historyState.flush()
    const project = historyState.projects.value.find((candidate) => candidate.id === projectId)
    if (!project || !historyState.moveHistoryToProject(historyId, projectId)) return false
    options.notify?.(`任务已加入“${project.name}”，资料视野已更新`)
    return true
  }

  function saveDetachedTask(input: {
    id: string
    projectId?: string
    parentConversationId?: string | null
    title: string
    messages: AiConversationMessage[]
  }): boolean {
    return historyState.saveDetachedTask(input)
  }

  function migrateLeakedTask(input: { id: string; title: string; prompt: string }): boolean {
    const migrated = historyState.migrateLeakedTask(input)
    if (!migrated) return false
    if (historyState.currentId.value === migrated.sourceHistoryId) {
      messages.value = messages.value.filter((message) => !migrated.messageIds.includes(message.id))
    }
    return true
  }

  function ensureConversationId(): string {
    if (!historyState.currentId.value) historyState.currentId.value = options.createId()
    return historyState.currentId.value
  }

  function beginRunSession(): {
    id: string
    projectId: string
    mode: Ref<AiChatMode>
    prompt: Ref<string>
    messages: Ref<AiConversationMessage[]>
    error: Ref<string>
  } | null {
    const sourcePrompt = prompt.value.trim()
    if (!sourcePrompt) return null
    const id = ensureConversationId()
    const existing = runSessions.get(id)
    if (existing) return null

    const projectId = historyState.activeProjectId.value
    const session = {
      projectId,
      mode: ref(options.mode.value),
      prompt: ref(sourcePrompt),
      messages: ref(messages.value.map((message) => ({ ...message }))),
      error: ref(''),
      stopWatch: () => undefined,
    }
    session.stopWatch = watch(
      session.messages,
      () => syncRunSession(id),
      { deep: true },
    )
    runSessions.set(id, session)
    prompt.value = ''
    options.error.value = ''
    return { id, ...session }
  }

  function finishRunSession(conversationId: string): void {
    const session = runSessions.get(conversationId)
    if (!session) return
    syncRunSession(conversationId)
    session.stopWatch()
    runSessions.delete(conversationId)
  }

  function syncRunSession(conversationId: string): void {
    const session = runSessions.get(conversationId)
    if (!session) return
    const sessionMessages = session.messages.value.map((message) => ({ ...message }))
    if (sessionMessages.some((message) => message.content.trim() || message.reasoningContent?.trim())) {
      historyState.saveDetachedTask({
        id: conversationId,
        projectId: session.projectId,
        title:
          sessionMessages.find((message) => message.role === 'user')?.content ?? '未命名任务',
        messages: sessionMessages,
      })
      if (activeDraft.value?.id === conversationId) activeDraft.value = null
    }
    if (historyState.currentId.value === conversationId) {
      messages.value = sessionMessages
      options.error.value = session.error.value
      options.mode.value = session.mode.value
    }
  }

  function isCurrentConversationRunning(): boolean {
    return runSessions.has(historyState.currentId.value ?? '')
  }

  function requestConversationTitle(conversationId: string, sourcePrompt: string): void {
    if (
      !options.generateTitle ||
      requestedTitleIds.has(conversationId) ||
      !historyState.needsTitle(conversationId)
    ) {
      return
    }
    requestedTitleIds.add(conversationId)
    void options
      .generateTitle(sourcePrompt, options.settings.value)
      .then((title) => historyState.setTitle(conversationId, title))
      .catch(() => undefined)
  }

  function restoreMessageForEditing(message: AiConversationMessage, messageIndex: number): void {
    prompt.value = message.content
    options.mode.value = message.mode
    historyState.resetCurrent()
    messages.value = messages.value.slice(0, messageIndex)
    options.error.value = ''
  }

  function findMessageIndex(messageId: string): number {
    return messages.value.findIndex((message) => message.id === messageId)
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      stopHistoryWatch()
      stopHistoryPersistenceWatch?.()
      for (const session of runSessions.values()) session.stopWatch()
      if (historyPersistenceEnabled()) historyState.flush()
    })
  }

  return {
    messages,
    prompt,
    history: visibleHistory,
    projectHistory: visibleProjectHistory,
    projects: historyState.orderedProjects,
    activeProject: historyState.activeProject,
    activeProjectId: historyState.activeProjectId,
    currentHistoryId: historyState.currentId,
    ensureConversationId,
    beginRunSession,
    finishRunSession,
    isConversationRunning: (conversationId: string | null) =>
      Boolean(conversationId && runSessions.has(conversationId)),
    requestConversationTitle,
    clear,
    forkAtMessage,
    editMessage,
    prepareRetry,
    selectHistory,
    deleteHistory,
    selectProject,
    createProject,
    deleteProject,
    startTask,
    moveHistoryToProject,
    saveDetachedTask,
    migrateLeakedTask,
    toggleProjectPin: historyState.toggleProjectPin,
    toggleHistoryPin: historyState.toggleHistoryPin,
    renameProject: historyState.renameProject,
    updateWorkspace: historyState.updateWorkspace,
    ensureDefaultWorkspace: historyState.ensureDefaultWorkspace,
    flushHistory: historyState.flush,
  }
}

export type UseAiConversationReturn = ReturnType<typeof useAiConversation>
