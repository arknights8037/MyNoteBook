import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

import {
  aiConversationToKnowledgeAsset,
  extractKnowledgeAssetFile,
  materializeAiConversationImport,
  parseAiConversationImport,
} from './KnowledgeAssetImporter'

describe('KnowledgeAssetImporter', () => {
  it('imports text-based document assets', async () => {
    const file = new File(['# 手册\n\n安全要求'], 'handbook.md', { type: 'text/markdown' })

    await expect(extractKnowledgeAssetFile(file)).resolves.toMatchObject({
      title: 'handbook',
      format: 'MD',
      sourceType: 'text_file',
      text: expect.stringContaining('安全要求'),
    })
  })

  it('extracts workbook sheets as searchable text', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['项目', '状态'],
        ['知识库', '进行中'],
      ]),
      '进度',
    )
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = new File([bytes], 'status.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    const result = await extractKnowledgeAssetFile(file)

    expect(result.sourceType).toBe('office_file')
    expect(result.text).toContain('# status')
    expect(result.text).toContain('## 进度')
    expect(result.text).toContain('| 项目 | 状态 |')
    expect(result.text).toContain('| 知识库 | 进行中 |')
  })

  it('projects AI conversations into attributed Markdown', () => {
    const result = aiConversationToKnowledgeAsset({
      id: 'chat-1',
      projectId: 'project-1',
      title: '架构讨论',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      provider: 'openai',
      model: 'gpt-5',
      pinnedAt: null,
      messages: [
        { id: 'm1', role: 'user', mode: 'ask', content: '如何拆分？', status: 'done' },
        { id: 'm2', role: 'assistant', mode: 'ask', content: '按领域拆分。', status: 'done' },
      ],
    })

    expect(result.text).toContain('openai · gpt-5')
    expect(result.text).toContain('## 用户')
    expect(result.text).toContain('## AI 助手')
  })

  it('imports a single JSON conversation file', async () => {
    const file = new File(
      [
        JSON.stringify({
          title: '方案评审',
          provider: 'openai',
          model: 'gpt-5',
          messages: [
            { role: 'user', content: '检查方案' },
            { role: 'assistant', content: '发现两个风险' },
          ],
        }),
      ],
      'review.json',
      { type: 'application/json' },
    )

    const result = await parseAiConversationImport(file)

    expect(result.failures).toEqual([])
    expect(result.conversations[0]).toMatchObject({
      title: '方案评审',
      provider: 'openai',
      model: 'gpt-5',
      messageCount: 2,
      format: 'AI CHAT · JSON',
    })
    expect(result.conversations[0]?.text).toContain('## AI 助手')
    expect(result.conversations[0]?.availableModes).toEqual(['conversation', 'markdown'])
  })

  it('converts generic JSON into hierarchical Markdown', async () => {
    const file = new File(
      [
        JSON.stringify({
          title: '项目资料',
          owner: 'Ada',
          milestones: [{ name: 'Alpha', done: true }],
        }),
      ],
      'project.json',
      { type: 'application/json' },
    )

    const result = await parseAiConversationImport(file)
    const candidate = result.conversations[0]!
    const materialized = materializeAiConversationImport({ candidate, mode: 'markdown' })

    expect(candidate.availableModes).toEqual(['markdown'])
    expect(materialized).toMatchObject({ sourceType: 'text_file', format: 'JSON · MARKDOWN' })
    expect(materialized.text).toContain('# 项目资料')
    expect(materialized.text).toContain('**owner：** Ada')
    expect(materialized.text).toContain('### milestones')
  })

  it('materializes conversation JSON as a conversation page', async () => {
    const file = new File(
      [
        JSON.stringify({
          messages: [
            { role: 'user', content: '问题' },
            { role: 'assistant', content: '回答' },
          ],
        }),
      ],
      'chat.json',
      { type: 'application/json' },
    )
    const candidate = (await parseAiConversationImport(file)).conversations[0]!

    expect(materializeAiConversationImport({ candidate, mode: 'conversation' })).toMatchObject({
      sourceType: 'ai_chat',
      format: 'AI CHAT · JSON',
      messageCount: 2,
      text: expect.stringContaining('## AI 助手'),
    })
  })

  it('recognizes frontmatter titles in single Markdown files', async () => {
    const file = new File(['---\ntitle: 发布复盘\n---\n\n## 用户\n\n总结问题'], 'fallback.md', {
      type: 'text/markdown',
    })

    const result = await parseAiConversationImport(file)

    expect(result.conversations[0]?.title).toBe('发布复盘')
  })

  it('understands ChatGPT mapping exports', async () => {
    const file = new File(
      [
        JSON.stringify({
          title: '映射格式对话',
          mapping: {
            one: { message: { author: { role: 'user' }, content: { parts: ['第一问'] } } },
            two: { message: { author: { role: 'assistant' }, content: { parts: ['第一答'] } } },
          },
        }),
      ],
      'mapping.json',
      { type: 'application/json' },
    )

    const result = await parseAiConversationImport(file)

    expect(result.conversations[0]?.messageCount).toBe(2)
    expect(result.conversations[0]?.text).toContain('第一问')
    expect(result.conversations[0]?.text).toContain('第一答')
  })

  it('understands message arrays whose text is stored in contents fragments', async () => {
    const file = new File(
      [
        JSON.stringify([
          {
            role: 'user',
            model: 'chatgpt',
            displayModel: 'ChatGPT',
            modelId: 'gpt-5-6-thinking',
            contents: [{ type: 'text', content: '如何设计 Agent？' }],
          },
          {
            role: 'assistant',
            model: 'chatgpt',
            modelId: 'gpt-5-5-thinking',
            contents: [
              { type: 'text', content: '' },
              { type: 'text', content: '先设计受控工具。' },
              { type: 'text', content: '再设计变更集。' },
            ],
          },
        ]),
      ],
      'Agent能力系统设计.json',
      { type: 'application/json' },
    )

    const candidate = (await parseAiConversationImport(file)).conversations[0]!

    expect(candidate).toMatchObject({
      title: 'Agent能力系统设计',
      provider: 'ChatGPT',
      model: 'gpt-5-6-thinking',
      messageCount: 2,
      defaultMode: 'conversation',
    })
    expect(candidate.conversationText).toContain('如何设计 Agent？')
    expect(candidate.conversationText).toContain('先设计受控工具。\n再设计变更集。')
  })

  it('finds conversations in nested containers and supports model roles with parts', async () => {
    const file = new File(
      [
        JSON.stringify({
          data: {
            conversation: {
              messages: [
                { role: 'user', parts: [{ text: '嵌套问题' }] },
                { role: 'model', parts: [{ text: '嵌套回答' }] },
              ],
            },
          },
        }),
      ],
      'nested.json',
      { type: 'application/json' },
    )

    const candidate = (await parseAiConversationImport(file)).conversations[0]!

    expect(candidate.messageCount).toBe(2)
    expect(candidate.conversationText).toContain('## AI 助手\n\n嵌套回答')
  })

  it('keeps document JSON retrieval content as Markdown', async () => {
    const file = new File(
      [JSON.stringify({ title: '配置说明', enabled: true, rules: ['审批', '回滚'] })],
      'config.json',
      { type: 'application/json' },
    )

    const result = await extractKnowledgeAssetFile(file)

    expect(result.text).toContain('# 配置说明')
    expect(result.text).toContain('**enabled：** true')
    expect(result.text).not.toContain('{"title"')
  })

  it('imports supported conversation pages from ZIP and reports bad entries', async () => {
    const archive = new JSZip()
    archive.file(
      'chat/第一个对话.md',
      '# 内容中的另一标题\n\n## 用户\n\n你好\n\n## AI 助手\n\n你好',
    )
    archive.file('chat/two.txt', 'User\n问题\nAssistant\n回答')
    archive.file('chat/broken.json', '{bad json')
    archive.file('chat/ignored.csv', 'not,a,conversation')
    const zip = await archive.generateAsync({ type: 'uint8array' })

    const result = await parseAiConversationImport(
      new File([zip], 'chats.zip', { type: 'application/zip' }),
    )

    expect(result.conversations).toHaveLength(2)
    expect(result.conversations.map((item) => item.title)).toEqual(['第一个对话', 'two'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('broken.json')
  })
})
