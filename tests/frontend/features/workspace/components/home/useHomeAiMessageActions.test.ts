import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import type { UseAiConversationReturn } from '@/composables/useAiConversation'
import type { UseDocumentAutosaveReturn } from '@/composables/useDocumentAutosave'
import { useHomeAiMessageActions } from '@/features/workspace/components/home/useHomeAiMessageActions'

describe('useHomeAiMessageActions', () => {
  it('opens chat with a default prompt and inserts assistant output', () => {
    const prompt = ref('')
    const showChat = ref(false)
    const insertMarkdown = vi.fn()
    const success = vi.fn()
    const actions = useHomeAiMessageActions({
      conversation: {
        prompt,
        prepareRetry: vi.fn(() => false),
        selectHistory: vi.fn(() => false),
      } as unknown as UseAiConversationReturn,
      showChat,
      editor: ref({ insertMarkdown } as never),
      currentDocumentId: ref('doc-1'),
      autosave: {} as UseDocumentAutosaveReturn,
      actionError: ref(null),
      runAssistant: vi.fn(),
      runDocumentAction: vi.fn(),
      selectDocument: vi.fn(),
      createDocument: vi.fn(),
      loadDocument: vi.fn(),
      expandDocument: vi.fn(),
      notify: { success, error: vi.fn() },
    })

    actions.openChat()
    actions.insertMessage('整理后的内容')

    expect(showChat.value).toBe(true)
    expect(prompt.value).toContain('Markdown 摘要')
    expect(insertMarkdown).toHaveBeenCalledWith('整理后的内容')
    expect(success).toHaveBeenCalledWith('AI 回复已插入文档')
  })

  it('runs a retry only when the conversation can be rewound', async () => {
    const runAssistant = vi.fn(async () => undefined)
    const actions = useHomeAiMessageActions({
      conversation: {
        prompt: ref(''),
        prepareRetry: vi.fn(() => true),
        selectHistory: vi.fn(() => false),
      } as unknown as UseAiConversationReturn,
      showChat: ref(false),
      editor: ref(null),
      currentDocumentId: ref('doc-1'),
      autosave: {} as UseDocumentAutosaveReturn,
      actionError: ref(null),
      runAssistant,
      runDocumentAction: vi.fn(),
      selectDocument: vi.fn(),
      createDocument: vi.fn(),
      loadDocument: vi.fn(),
      expandDocument: vi.fn(),
      notify: { success: vi.fn(), error: vi.fn() },
    })

    await actions.retryMessage('message-1')
    expect(runAssistant).toHaveBeenCalledOnce()
  })
})
