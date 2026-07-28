import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAiConversation } from '@/composables/useAiConversation'
import {
  createEmptyAgentWorkspaceHistory,
  DEFAULT_AGENT_PROJECT_ID,
  UNGROUPED_AGENT_PROJECT_ID,
  type AgentWorkspaceHistoryState,
} from '@/models/ai/aiChatHistory'
import type { AgentWorkspaceHistoryStore } from '@/repositories/agent/AgentWorkspaceHistoryStore'
import { createAiSettings } from '@/models/ai/ai'

function createConversation(
  options: {
    running?: boolean
    notify?: (message: string) => void
    persistedState?: AgentWorkspaceHistoryState
    persistHistory?: boolean
    generateTitle?: (
      prompt: string,
      settings: ReturnType<typeof createAiSettings>,
    ) => Promise<string>
    historyStore?: AgentWorkspaceHistoryStore
  } = {},
) {
  const scope = effectScope()
  const error = ref('old error')
  const mode = ref<'ask' | 'edit' | 'agent' | 'auto'>('ask')
  const stop = vi.fn()
  const conversation = scope.run(() =>
    useAiConversation({
      settings: ref(createAiSettings('openai-compatible')),
      mode,
      error,
      isRunning: ref(Boolean(options.running)),
      createId: () => 'new-history',
      stop,
      notify: options.notify,
      historyStore: options.historyStore ?? memoryHistoryStore(options.persistedState),
      generateTitle: options.generateTitle,
      persistHistory:
        options.persistHistory === undefined ? undefined : ref(options.persistHistory),
    }),
  )!

  return { conversation, error, mode, scope, stop }
}

describe('useAiConversation', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('clears the active conversation and stops only its running request', () => {
    const { conversation, error, scope, stop } = createConversation()
    conversation.messages.value = [message('user-1', 'user', 'hello')]
    conversation.prompt.value = '继续处理'
    const session = conversation.beginRunSession()

    conversation.clear()

    expect(stop).toHaveBeenCalledWith(session?.id)
    expect(conversation.messages.value).toEqual([])
    expect(error.value).toBe('')
    scope.stop()
  })

  it('keeps an auxiliary conversation out of history while persistence is disabled', async () => {
    const { conversation, scope } = createConversation({ persistHistory: false })
    conversation.messages.value = [message('temporary', 'user', '临时文档辅助任务')]

    await Promise.resolve()
    await vi.runAllTimersAsync()

    expect(conversation.history.value).toEqual([])
    scope.stop()
    expect(conversation.history.value).toEqual([])
  })

  it('forks at a message without sharing the current history id', () => {
    const notify = vi.fn()
    const { conversation, error, scope } = createConversation({ notify })
    conversation.messages.value = [
      message('user-1', 'user', 'question'),
      message('assistant-1', 'assistant', 'answer'),
      message('user-2', 'user', 'follow-up'),
    ]
    conversation.currentHistoryId.value = 'old-history'

    expect(conversation.forkAtMessage('assistant-1')).toBe(true)
    expect(conversation.messages.value.map(({ id }) => id)).toEqual(['user-1', 'assistant-1'])
    expect(conversation.currentHistoryId.value).toBeNull()
    expect(error.value).toBe('')
    expect(notify).toHaveBeenCalledWith('已从此处创建对话分支')
    scope.stop()
  })

  it('loads a selected message into the prompt and removes later messages', () => {
    const { conversation, mode, scope } = createConversation()
    conversation.messages.value = [
      message('user-1', 'user', 'first'),
      message('assistant-1', 'assistant', 'answer'),
      message('user-2', 'user', 'rewrite this', 'edit'),
    ]

    expect(conversation.editMessage('user-2')).toBe(true)
    expect(conversation.prompt.value).toBe('rewrite this')
    expect(mode.value).toBe('edit')
    expect(conversation.messages.value.map(({ id }) => id)).toEqual(['user-1', 'assistant-1'])
    scope.stop()
  })

  it('prepares retry from the latest user message before an assistant response', () => {
    const { conversation, mode, scope } = createConversation()
    conversation.messages.value = [
      message('user-1', 'user', 'first'),
      message('assistant-1', 'assistant', 'answer'),
      message('user-2', 'user', 'agent task', 'agent'),
      message('assistant-2', 'assistant', 'failed', 'agent'),
    ]

    expect(conversation.prepareRetry('assistant-2')).toBe(true)
    expect(conversation.prompt.value).toBe('agent task')
    expect(mode.value).toBe('agent')
    expect(conversation.messages.value.map(({ id }) => id)).toEqual(['user-1', 'assistant-1'])
    scope.stop()
  })

  it('restores and removes persisted history while guarding edits during a run', async () => {
    const persistedState: AgentWorkspaceHistoryState = {
      ...createEmptyAgentWorkspaceHistory(),
      items: [
        {
          id: 'saved-history',
          projectId: DEFAULT_AGENT_PROJECT_ID,
          title: 'Saved',
          updatedAt: 1,
          messageCount: 2,
          provider: 'openai-compatible',
          model: 'model',
          pinnedAt: null,
          messages: [
            message('saved-user', 'user', 'saved question', 'ask'),
            message('saved-assistant', 'assistant', 'saved answer', 'edit'),
          ],
        },
      ],
    }
    const active = createConversation({ persistedState })
    await Promise.resolve()

    expect(active.conversation.selectHistory('saved-history')).toBe(true)
    expect(active.conversation.messages.value).toHaveLength(2)
    expect(active.mode.value).toBe('edit')
    expect(active.conversation.deleteHistory('saved-history')).toBe(true)
    expect(active.conversation.messages.value).toEqual([])

    const running = createConversation()
    running.conversation.messages.value = [message('user-1', 'user', 'keep')]
    running.conversation.prompt.value = '继续运行'
    running.conversation.beginRunSession()
    expect(running.conversation.editMessage('user-1')).toBe(false)
    expect(running.conversation.forkAtMessage('user-1')).toBe(false)
    expect(running.conversation.selectHistory('saved-history')).toBe(false)
    expect(running.conversation.messages.value).toHaveLength(1)

    active.scope.stop()
    running.scope.stop()
  })

  it('creates configured projects and keeps pinned conversations first', async () => {
    const state = createEmptyAgentWorkspaceHistory()
    state.items = [historyItem('older', 10), historyItem('newer', 20)]
    const notify = vi.fn()
    const { conversation, scope } = createConversation({ persistedState: state, notify })
    await Promise.resolve()

    expect(conversation.history.value.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(conversation.toggleHistoryPin('older')).toBe(true)
    expect(conversation.history.value.map((item) => item.id)).toEqual(['older', 'newer'])

    conversation.createProject({ name: 'StudioSite', workspaceRootIds: ['group-studio'] })
    expect(conversation.activeProject.value).toMatchObject({
      name: 'StudioSite',
      workspaceRootIds: ['group-studio'],
    })
    expect(notify).toHaveBeenCalledWith('项目“StudioSite”已创建')
    expect(conversation.toggleProjectPin(conversation.activeProjectId.value)).toBe(true)
    expect(conversation.projects.value[0]).toMatchObject({ name: 'StudioSite' })
    scope.stop()
  })

  it('keeps creation order and timestamps unchanged when an old conversation is opened', async () => {
    const state = createEmptyAgentWorkspaceHistory()
    state.items = [historyItem('older', 10), historyItem('newer', 20)]
    const { conversation, scope } = createConversation({ persistedState: state })
    await Promise.resolve()

    expect(conversation.selectHistory('older')).toBe(true)
    await Promise.resolve()
    await vi.runAllTimersAsync()

    expect(conversation.history.value.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(conversation.history.value.find((item) => item.id === 'older')?.updatedAt).toBe(10)
    scope.stop()
  })

  it('updates message activity without moving a conversation from its creation position', async () => {
    const state = createEmptyAgentWorkspaceHistory()
    state.items = [historyItem('older', 10), historyItem('newer', 20)]
    const { conversation, scope } = createConversation({ persistedState: state })
    await Promise.resolve()
    vi.setSystemTime(100)

    expect(conversation.selectHistory('older')).toBe(true)
    conversation.messages.value.push(message('older-follow-up', 'user', '继续处理', 'agent'))
    conversation.flushHistory()

    expect(conversation.history.value.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(conversation.history.value.find((item) => item.id === 'older')?.updatedAt).toBe(100)
    scope.stop()
  })

  it('runs one background title task for a new conversation', async () => {
    const generateTitle = vi.fn(async () => '自动生成标题')
    const { conversation, scope } = createConversation({ generateTitle })
    await Promise.resolve()
    const conversationId = conversation.ensureConversationId()

    conversation.requestConversationTitle(conversationId, '修复对话历史')
    conversation.requestConversationTitle(conversationId, '不应重复')
    await Promise.resolve()
    conversation.messages.value = [message('user-1', 'user', '修复对话历史', 'agent')]
    conversation.flushHistory()

    expect(generateTitle).toHaveBeenCalledOnce()
    expect(conversation.history.value[0]).toMatchObject({
      id: conversationId,
      title: '自动生成标题',
    })
    scope.stop()
  })

  it('allows another project to be created while an Agent task is running', () => {
    const notify = vi.fn()
    const { conversation, scope } = createConversation({ running: true, notify })

    conversation.createProject({ name: 'Parallel project' })

    expect(conversation.projects.value).toHaveLength(2)
    expect(conversation.projects.value.at(-1)?.name).toBe('Parallel project')
    scope.stop()
  })

  it('creates persistent ungrouped tasks and project-scoped tasks explicitly', async () => {
    const { conversation, scope } = createConversation()
    await Promise.resolve()

    expect(conversation.startTask(null)).toBe(true)
    expect(conversation.activeProjectId.value).toBe(UNGROUPED_AGENT_PROJECT_ID)
    expect(conversation.activeProject.value).toBeNull()
    conversation.messages.value = [message('loose-message', 'user', '未分组任务', 'agent')]
    conversation.flushHistory()
    expect(conversation.history.value[0]?.projectId).toBe(UNGROUPED_AGENT_PROJECT_ID)

    expect(conversation.startTask(DEFAULT_AGENT_PROJECT_ID)).toBe(true)
    expect(conversation.activeProjectId.value).toBe(DEFAULT_AGENT_PROJECT_ID)
    expect(conversation.messages.value).toEqual([])
    scope.stop()
  })

  it('does not persist an empty task window before the user sends input', async () => {
    const save = vi.fn(async () => undefined)
    const historyStore: AgentWorkspaceHistoryStore = {
      load: vi.fn(async () => createEmptyAgentWorkspaceHistory()),
      save,
    }
    const { conversation, scope } = createConversation({ historyStore })
    await Promise.resolve()

    expect(conversation.startTask(DEFAULT_AGENT_PROJECT_ID)).toBe(true)
    await vi.runAllTimersAsync()

    expect(conversation.currentHistoryId.value).toBe('new-history')
    expect(conversation.history.value).toEqual([
      expect.objectContaining({
        id: 'new-history',
        projectId: DEFAULT_AGENT_PROJECT_ID,
        title: '新对话',
        messageCount: 0,
        transient: true,
      }),
    ])
    expect(save).not.toHaveBeenCalled()
    scope.stop()
  })

  it('keeps a running task isolated after another empty task is opened', async () => {
    const { conversation, scope } = createConversation()
    await Promise.resolve()
    conversation.prompt.value = '后台整理资料'
    const session = conversation.beginRunSession()!
    session.messages.value.push(message('run-user', 'user', '后台整理资料', 'agent'))
    await nextTick()

    expect(conversation.startTask(null)).toBe(true)
    const draftId = conversation.currentHistoryId.value
    session.messages.value.push(message('run-assistant', 'assistant', '整理完成', 'agent'))
    await nextTick()

    expect(conversation.currentHistoryId.value).toBe(draftId)
    expect(draftId).not.toBe(session.id)
    expect(conversation.messages.value).toEqual([])
    expect(conversation.history.value.find((item) => item.id === session.id)).toMatchObject({
      projectId: DEFAULT_AGENT_PROJECT_ID,
      messageCount: 2,
    })
    conversation.finishRunSession(session.id)
    scope.stop()
  })

  it('moves an ungrouped task into a project and adopts its workspace', async () => {
    const state = createEmptyAgentWorkspaceHistory()
    state.projects[0]!.workspaceRootIds = ['group-policy']
    state.items = [
      {
        ...historyItem('loose-task', 10),
        projectId: UNGROUPED_AGENT_PROJECT_ID,
      },
    ]
    const notify = vi.fn()
    const { conversation, scope } = createConversation({ persistedState: state, notify })
    await Promise.resolve()

    expect(conversation.selectHistory('loose-task')).toBe(true)
    expect(conversation.activeProject.value).toBeNull()
    expect(conversation.moveHistoryToProject('loose-task', DEFAULT_AGENT_PROJECT_ID)).toBe(true)

    expect(conversation.currentHistoryId.value).toBe('loose-task')
    expect(conversation.history.value[0]).toMatchObject({
      id: 'loose-task',
      projectId: DEFAULT_AGENT_PROJECT_ID,
    })
    expect(conversation.activeProject.value?.workspaceRootIds).toEqual(['group-policy'])
    expect(conversation.messages.value[0]?.content).toBe('loose-task')
    expect(notify).toHaveBeenCalledWith('任务已加入“Agent MVP”，资料视野已更新')
    scope.stop()
  })

  it('persists a detached A2A task without switching the active conversation', async () => {
    const { conversation, scope } = createConversation()
    await Promise.resolve()
    conversation.messages.value = [message('active', 'user', '当前对话')]
    conversation.currentHistoryId.value = 'active-history'

    expect(
      conversation.saveDetachedTask({
        id: 'a2a-request-1',
        parentConversationId: 'conversation-parent',
        title: 'A2A · 同步项目文档',
        messages: [
          message('a2a-user', 'user', '同步项目文档', 'agent'),
          message('a2a-assistant', 'assistant', '已完成同步', 'agent'),
        ],
      }),
    ).toBe(true)

    expect(conversation.currentHistoryId.value).toBe('active-history')
    expect(conversation.messages.value).toEqual([message('active', 'user', '当前对话')])
    expect(conversation.history.value[0]).toMatchObject({
      id: 'a2a-request-1',
      projectId: UNGROUPED_AGENT_PROJECT_ID,
      title: 'A2A · 同步项目文档',
      messageCount: 2,
      parentConversationId: 'conversation-parent',
    })
    scope.stop()
  })

  it('repairs a legacy A2A message pair that leaked into an active conversation', async () => {
    const state = createEmptyAgentWorkspaceHistory()
    state.items = [
      {
        ...historyItem('active-history', 10),
        messages: [
          message('original', 'user', '原对话内容', 'agent'),
          message('leaked-user', 'user', '同步文档', 'agent'),
          message('leaked-assistant', 'assistant', '同步完成', 'agent'),
        ],
        messageCount: 3,
      },
    ]
    const { conversation, scope } = createConversation({ persistedState: state })
    await Promise.resolve()
    expect(conversation.selectHistory('active-history')).toBe(true)

    expect(
      conversation.migrateLeakedTask({
        id: 'a2a-request-legacy',
        title: 'A2A · 同步文档',
        prompt: '同步文档',
      }),
    ).toBe(true)

    expect(conversation.currentHistoryId.value).toBe('active-history')
    expect(conversation.messages.value.map((item) => item.id)).toEqual(['original'])
    expect(
      conversation.history.value.find((item) => item.id === 'active-history')?.messageCount,
    ).toBe(1)
    expect(
      conversation.history.value.find((item) => item.id === 'a2a-request-legacy'),
    ).toMatchObject({
      projectId: UNGROUPED_AGENT_PROJECT_ID,
      messageCount: 2,
    })
    scope.stop()
  })

  it('opens a second task while the first task keeps running in isolation', () => {
    const { conversation, scope } = createConversation()
    conversation.prompt.value = '第一个任务'
    const session = conversation.beginRunSession()

    expect(session).not.toBeNull()
    expect(conversation.startTask(null)).toBe(true)
    expect(conversation.currentHistoryId.value).not.toBe(session!.id)
    expect(conversation.history.value.find((item) => item.transient)).toMatchObject({
      title: '新对话',
      projectId: UNGROUPED_AGENT_PROJECT_ID,
    })
    expect(conversation.isConversationRunning(session!.id)).toBe(true)
    scope.stop()
  })
})

function memoryHistoryStore(
  initial: AgentWorkspaceHistoryState = createEmptyAgentWorkspaceHistory(),
): AgentWorkspaceHistoryStore {
  let state = structuredClone(initial)
  return {
    async load() {
      return structuredClone(state)
    },
    async save(next) {
      state = structuredClone(next)
    },
  }
}

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  mode: 'ask' | 'edit' | 'agent' | 'auto' = 'ask',
) {
  return { id, role, mode, content, status: 'done' as const }
}

function historyItem(id: string, updatedAt: number) {
  return {
    id,
    projectId: DEFAULT_AGENT_PROJECT_ID,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    provider: 'openai-compatible',
    model: 'model',
    pinnedAt: null,
    messages: [message(`${id}-message`, 'user', id, 'agent')],
  }
}
