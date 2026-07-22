import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AiConversationImportPreviewModal from '@/features/knowledge-control/components/AiConversationImportPreviewModal.vue'
import type { ImportedAiConversationFile } from '@/services/knowledge/KnowledgeAssetImporter'

describe('AiConversationImportPreviewModal', () => {
  it('supports multi-selection and per-JSON parse modes', async () => {
    const jsonCandidate = candidate({
      name: 'chat.json',
      title: 'JSON 对话',
      modes: ['conversation', 'markdown'],
      conversationText: '# JSON 对话\n\n## 用户\n\n问题',
      markdownText: '# JSON 对话\n\n## messages',
    })
    const markdownCandidate = candidate({ name: 'notes.md', title: '笔记' })
    const wrapper = mount(AiConversationImportPreviewModal, {
      props: {
        show: true,
        candidates: [jsonCandidate, markdownCandidate],
        failures: [],
        archiveName: 'export.zip',
        loading: false,
      },
      global: {
        stubs: {
          NModal: { template: '<section><slot /><slot name="footer" /></section>' },
        },
      },
    })

    expect(wrapper.text()).toContain('已选 2/2')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Markdown'))
      ?.trigger('click')
    await wrapper.find('input[aria-label="选择 笔记"]').setValue(false)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('导入所选'))
      ?.trigger('click')

    const selections = wrapper.emitted('confirm')?.[0]?.[0] as Array<{
      candidate: ImportedAiConversationFile
      mode: string
    }>
    expect(selections).toHaveLength(1)
    expect(selections[0]).toMatchObject({ candidate: { title: 'JSON 对话' }, mode: 'markdown' })
  })
})

function candidate(input: {
  name: string
  title: string
  modes?: Array<'conversation' | 'markdown'>
  conversationText?: string
  markdownText?: string
}): ImportedAiConversationFile {
  const modes = input.modes ?? ['conversation']
  return {
    file: new File(['content'], input.name),
    originalPath: `archive/${input.name}`,
    title: input.title,
    text: input.conversationText ?? '# 内容',
    markdownText: input.markdownText ?? '# 内容',
    conversationText: input.conversationText ?? '# 内容',
    format: input.name.endsWith('.json') ? 'AI CHAT · JSON' : 'AI CHAT · MARKDOWN',
    provider: '',
    model: '',
    messageCount: input.conversationText ? 1 : 0,
    availableModes: modes,
    defaultMode: modes[0]!,
  }
}
