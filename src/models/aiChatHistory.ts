import type { AiChatMode, AiChatRole, AiChatStatus } from './aiChatMode'

export interface AiChatHistoryMessage {
  id: string
  role: AiChatRole
  mode: AiChatMode
  content: string
  reasoningContent?: string
  status: AiChatStatus
}

export interface AiChatHistoryItem {
  id: string
  title: string
  updatedAt: number
  messageCount: number
  provider: string
  model: string
  messages: AiChatHistoryMessage[]
}

interface AiChatHistoryPayload {
  version: 1
  items: AiChatHistoryItem[]
}

const AI_CHAT_HISTORY_STORAGE_KEY = 'my-notebook:ai-chat-history'
export const AI_CHAT_HISTORY_LIMIT = 50

export function loadAiChatHistory(): AiChatHistoryItem[] {
  try {
    const raw = globalThis.localStorage?.getItem(AI_CHAT_HISTORY_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    const items = Array.isArray(parsed) ? parsed : isHistoryPayload(parsed) ? parsed.items : []

    return items
      .map(normalizeAiChatHistoryItem)
      .filter((item): item is AiChatHistoryItem => Boolean(item))
      .slice(0, AI_CHAT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

export function saveAiChatHistory(history: AiChatHistoryItem[]): void {
  try {
    const payload: AiChatHistoryPayload = {
      version: 1,
      items: history
        .map(normalizeAiChatHistoryItem)
        .filter((item): item is AiChatHistoryItem => Boolean(item))
        .slice(0, AI_CHAT_HISTORY_LIMIT),
    }
    globalThis.localStorage?.setItem(AI_CHAT_HISTORY_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage failures; the chat UI should remain usable.
  }
}

function isHistoryPayload(value: unknown): value is Partial<AiChatHistoryPayload> {
  return Boolean(
    value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items),
  )
}

function normalizeAiChatHistoryItem(value: unknown): AiChatHistoryItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<AiChatHistoryItem>
  const messages = normalizeAiMessages(item.messages)
  if (!item.id || typeof item.id !== 'string' || messages.length === 0) return null

  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '未命名对话',
    updatedAt:
      typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : Date.now(),
    messageCount: messages.length,
    provider: typeof item.provider === 'string' ? item.provider : '',
    model: typeof item.model === 'string' ? item.model : '',
    messages,
  }
}

function normalizeAiMessages(value: unknown): AiChatHistoryMessage[] {
  if (!Array.isArray(value)) return []

  return value
    .map((messageValue): AiChatHistoryMessage | null => {
      if (!messageValue || typeof messageValue !== 'object') return null
      const chatMessage = messageValue as Partial<AiChatHistoryMessage>
      if (
        typeof chatMessage.id !== 'string' ||
        (chatMessage.role !== 'user' && chatMessage.role !== 'assistant') ||
        !['ask', 'edit', 'agent', 'auto'].includes(chatMessage.mode) ||
        typeof chatMessage.content !== 'string'
      ) {
        return null
      }

      return {
        id: chatMessage.id,
        role: chatMessage.role,
        mode: chatMessage.mode,
        content: chatMessage.content,
        reasoningContent:
          typeof chatMessage.reasoningContent === 'string' ? chatMessage.reasoningContent : '',
        status: chatMessage.status === 'error' ? 'error' : 'done',
      }
    })
    .filter((chatMessage): chatMessage is AiChatHistoryMessage => Boolean(chatMessage))
}
