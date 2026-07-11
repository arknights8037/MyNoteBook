import { ref, type Ref } from 'vue'

import type { AiChatHistoryMessage, AiChatHistoryItem } from '@/models/aiChatHistory'
import { loadAiChatHistory, saveAiChatHistory } from '@/models/aiChatHistory'
import type { AiSettings } from '@/models/ai'

export function useAiChatHistory(
  messages: Ref<AiChatHistoryMessage[]>,
  settings: Ref<AiSettings>,
  createId: () => string,
) {
  const history = ref<AiChatHistoryItem[]>(loadAiChatHistory())
  const currentId = ref<string | null>(null)
  let saveTimer: number | null = null

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
    const record: AiChatHistoryItem = {
      id,
      title: createHistoryTitle(persistableMessages),
      updatedAt: Date.now(),
      messageCount: persistableMessages.length,
      provider: settings.value.provider,
      model: settings.value.model,
      messages: persistableMessages,
    }
    saveAiChatHistory([record, ...history.value.filter((item) => item.id !== id)])
    history.value = loadAiChatHistory()
  }

  function select(historyId: string): AiChatHistoryItem | null {
    const item = history.value.find((candidate) => candidate.id === historyId) ?? null
    if (item) currentId.value = item.id
    return item
  }

  function remove(historyId: string): boolean {
    const existed = history.value.some((item) => item.id === historyId)
    history.value = history.value.filter((item) => item.id !== historyId)
    if (currentId.value === historyId) currentId.value = null
    saveAiChatHistory(history.value)
    return existed
  }

  function resetCurrent(): void {
    currentId.value = null
  }

  return { history, currentId, scheduleSave, flush, select, remove, resetCurrent }
}

function createHistoryTitle(messages: AiChatHistoryMessage[]): string {
  const source =
    messages.find((message) => message.role === 'user')?.content ??
    messages.find((message) => message.content.trim())?.content ??
    messages[0]?.content ??
    ''
  return (
    source.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim().slice(0, 36) || '未命名对话'
  )
}
