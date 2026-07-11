export type AiChatMode = 'ask' | 'edit' | 'agent' | 'auto'
export type AiChatRole = 'user' | 'assistant'
export type AiChatStatus = 'streaming' | 'done' | 'error'

export interface AiSelectorOption<T extends string> {
  value: T
  label: string
  description?: string
}

export const AI_MODE_OPTIONS: Array<AiSelectorOption<AiChatMode>> = [
  { value: 'auto', label: 'Auto', description: '自动选择最合适的处理方式' },
  { value: 'ask', label: 'Ask', description: '在聊天里回答' },
  { value: 'edit', label: 'Edit', description: '把 Markdown 写入文档' },
  { value: 'agent', label: 'Agent', description: '检索资料并生成可确认的修改方案' },
]
