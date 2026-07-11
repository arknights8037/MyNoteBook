import { beforeEach, describe, expect, it } from 'vitest'

import { AI_CHAT_HISTORY_LIMIT, loadAiChatHistory, saveAiChatHistory } from './aiChatHistory'

describe('AI chat history', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('persists and restores chat history', () => {
    saveAiChatHistory([
      {
        id: 'history-1',
        title: '整理摘要',
        updatedAt: 100,
        messageCount: 2,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            mode: 'ask',
            content: '整理一下',
            status: 'done',
          },
          {
            id: 'message-2',
            role: 'assistant',
            mode: 'ask',
            content: '好的',
            reasoningContent: '先看结构',
            status: 'done',
          },
        ],
      },
    ])

    expect(loadAiChatHistory()).toMatchObject([
      {
        id: 'history-1',
        title: '整理摘要',
        messageCount: 2,
        messages: [{ content: '整理一下' }, { content: '好的', reasoningContent: '先看结构' }],
      },
    ])
  })

  it('normalizes invalid values and supports legacy array storage', () => {
    globalThis.localStorage.setItem(
      'my-notebook:ai-chat-history',
      JSON.stringify([
        {
          id: 'legacy',
          title: '',
          updatedAt: Number.NaN,
          messages: [
            { id: 'ok', role: 'assistant', mode: 'ask', content: 'answer', status: 'streaming' },
            { id: 'bad', role: 'system', mode: 'ask', content: 'ignored' },
          ],
        },
      ]),
    )

    expect(loadAiChatHistory()).toMatchObject([
      {
        id: 'legacy',
        title: '未命名对话',
        messageCount: 1,
        messages: [{ id: 'ok', status: 'done' }],
      },
    ])
  })

  it('limits persisted history size', () => {
    saveAiChatHistory(
      Array.from({ length: AI_CHAT_HISTORY_LIMIT + 5 }, (_, index) => ({
        id: `history-${index}`,
        title: `记录 ${index}`,
        updatedAt: index,
        messageCount: 1,
        provider: 'openai',
        model: 'gpt',
        messages: [
          {
            id: `message-${index}`,
            role: 'user' as const,
            mode: 'ask' as const,
            content: `问题 ${index}`,
            status: 'done' as const,
          },
        ],
      })),
    )

    expect(loadAiChatHistory()).toHaveLength(AI_CHAT_HISTORY_LIMIT)
  })

  it('restores agent and auto mode messages', () => {
    saveAiChatHistory([
      {
        id: 'agent-history',
        title: '知识整理',
        updatedAt: 100,
        messageCount: 2,
        provider: 'openai',
        model: 'gpt',
        messages: [
          { id: 'auto', role: 'user', mode: 'auto', content: '整理资料', status: 'done' },
          { id: 'agent', role: 'assistant', mode: 'agent', content: '整理结果', status: 'done' },
        ],
      },
    ])

    expect(loadAiChatHistory()[0]?.messages.map((message) => message.mode)).toEqual([
      'auto',
      'agent',
    ])
  })
})
