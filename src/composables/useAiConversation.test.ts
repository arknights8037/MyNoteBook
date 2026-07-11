import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAiConversation } from './useAiConversation'
import { saveAiChatHistory } from '@/models/aiChatHistory'
import { createAiSettings } from '@/models/ai'

function createConversation(
  options: { running?: boolean; notify?: (message: string) => void } = {},
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

  it('clears the active conversation and stops a running request', () => {
    const { conversation, error, scope, stop } = createConversation({ running: true })
    conversation.messages.value = [message('user-1', 'user', 'hello')]

    conversation.clear()

    expect(stop).toHaveBeenCalledOnce()
    expect(conversation.messages.value).toEqual([])
    expect(error.value).toBe('')
    scope.stop()
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

  it('restores and removes persisted history while guarding edits during a run', () => {
    saveAiChatHistory([
      {
        id: 'saved-history',
        title: 'Saved',
        updatedAt: 1,
        messageCount: 2,
        provider: 'openai-compatible',
        model: 'model',
        messages: [
          message('saved-user', 'user', 'saved question', 'ask'),
          message('saved-assistant', 'assistant', 'saved answer', 'edit'),
        ],
      },
    ])
    const active = createConversation()

    expect(active.conversation.selectHistory('saved-history')).toBe(true)
    expect(active.conversation.messages.value).toHaveLength(2)
    expect(active.mode.value).toBe('edit')
    expect(active.conversation.deleteHistory('saved-history')).toBe(true)
    expect(active.conversation.messages.value).toEqual([])

    const running = createConversation({ running: true })
    running.conversation.messages.value = [message('user-1', 'user', 'keep')]
    expect(running.conversation.editMessage('user-1')).toBe(false)
    expect(running.conversation.forkAtMessage('user-1')).toBe(false)
    expect(running.conversation.selectHistory('saved-history')).toBe(false)
    expect(running.conversation.messages.value).toHaveLength(1)

    active.scope.stop()
    running.scope.stop()
  })
})

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  mode: 'ask' | 'edit' | 'agent' | 'auto' = 'ask',
) {
  return { id, role, mode, content, status: 'done' as const }
}
