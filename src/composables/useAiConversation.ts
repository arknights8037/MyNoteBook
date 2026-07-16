import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

import { useAiChatHistory } from './useAiChatHistory'
import type { AiSettings } from '@/models/ai'
import type { AiChatHistoryMessage } from '@/models/aiChatHistory'
import type { AiChatMode } from '@/models/aiChatMode'
import type { KnowledgeSource } from '@/models/knowledgeRetrieval'
import type { AgentWorkspaceHistoryStore } from '@/infrastructure/database/AgentWorkspaceHistoryStore'

export interface AiConversationMessage extends AiChatHistoryMessage {
  sources?: KnowledgeSource[]
}

export interface AiConversationOptions {
  settings: Ref<AiSettings>
  mode: Ref<AiChatMode>
  error: Ref<string>
  isRunning: Readonly<Ref<boolean>>
  createId: () => string
  stop?: () => void
  notify?: (message: string) => void
  historyStore?: AgentWorkspaceHistoryStore
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
  const stopHistoryWatch = watch(messages, historyState.scheduleSave, { deep: true })

  function clear(): void {
    if (options.isRunning.value) options.stop?.()
    historyState.resetCurrent()
    messages.value = []
    options.error.value = ''
  }

  function forkAtMessage(messageId: string): boolean {
    if (options.isRunning.value) return false
    const messageIndex = findMessageIndex(messageId)
    if (messageIndex < 0) return false

    historyState.resetCurrent()
    messages.value = messages.value.slice(0, messageIndex + 1)
    options.error.value = ''
    options.notify?.('已从此处创建对话分支')
    return true
  }

  function editMessage(messageId: string): boolean {
    if (options.isRunning.value) return false
    const messageIndex = findMessageIndex(messageId)
    const message = messages.value[messageIndex]
    if (!message) return false

    restoreMessageForEditing(message, messageIndex)
    options.notify?.('已载入该条对话，可修改后重新发送')
    return true
  }

  function prepareRetry(messageId: string): boolean {
    if (options.isRunning.value) return false
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
    if (options.isRunning.value) return false
    const historyItem = historyState.select(historyId)
    if (!historyItem) return false

    messages.value = historyItem.messages.map((message) => ({ ...message }))
    prompt.value = ''
    options.error.value = ''
    options.mode.value = messages.value.at(-1)?.mode ?? 'agent'
    return true
  }

  function deleteHistory(historyId: string): boolean {
    if (historyState.currentId.value === historyId) {
      messages.value = []
      options.error.value = ''
    }
    const removed = historyState.remove(historyId)
    if (removed) options.notify?.('聊天记录已删除')
    return removed
  }

  function selectProject(projectId: string): boolean {
    if (options.isRunning.value) return false
    historyState.flush()
    const project = historyState.selectProject(projectId)
    if (!project) return false
    messages.value = []
    prompt.value = ''
    options.error.value = ''
    return true
  }

  function createProject(input?: { name?: string; workspaceRootIds?: string[] }): void {
    if (options.isRunning.value) {
      options.notify?.('请先停止当前 Agent 任务，再新建项目')
      return
    }
    historyState.flush()
    const project = historyState.createProject(input)
    messages.value = []
    prompt.value = ''
    options.error.value = ''
    options.notify?.(`项目“${project.name}”已创建`)
  }

  function startTask(projectId: string | null): boolean {
    if (options.isRunning.value) {
      options.notify?.('请先停止当前 Agent 任务，再新建任务')
      return false
    }
    historyState.flush()
    if (!historyState.startTask(projectId)) return false
    messages.value = []
    prompt.value = ''
    options.error.value = ''
    return true
  }

  function ensureConversationId(): string {
    if (!historyState.currentId.value) historyState.currentId.value = options.createId()
    return historyState.currentId.value
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
      historyState.flush()
    })
  }

  return {
    messages,
    prompt,
    history: historyState.orderedHistory,
    projectHistory: historyState.projectHistory,
    projects: historyState.orderedProjects,
    activeProject: historyState.activeProject,
    activeProjectId: historyState.activeProjectId,
    currentHistoryId: historyState.currentId,
    ensureConversationId,
    clear,
    forkAtMessage,
    editMessage,
    prepareRetry,
    selectHistory,
    deleteHistory,
    selectProject,
    createProject,
    startTask,
    toggleProjectPin: historyState.toggleProjectPin,
    toggleHistoryPin: historyState.toggleHistoryPin,
    renameProject: historyState.renameProject,
    updateWorkspace: historyState.updateWorkspace,
    ensureDefaultWorkspace: historyState.ensureDefaultWorkspace,
    flushHistory: historyState.flush,
  }
}

export type UseAiConversationReturn = ReturnType<typeof useAiConversation>
