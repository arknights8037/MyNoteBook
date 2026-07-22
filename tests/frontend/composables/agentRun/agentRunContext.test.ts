import { describe, expect, it, vi } from 'vitest'

import { buildAgentRunContext } from '@/composables/agentRun/agentRunContext'
import type { AgentRunDocumentAdapter, AgentRunSnapshot } from '@/composables/agentRun/types'
import type { DocumentSummary } from '@/models/documents/document'
import { createAiSettings } from '@/models/ai/ai'

describe('buildAgentRunContext', () => {
  it('falls back to the frozen document list and anchors matching knowledge blocks', async () => {
    const related = documentSummary('doc-2', '发布流程', '上线前需要完成灰度验证和回滚演练。')
    const snapshot = createSnapshot([related])
    const adapter = createAdapter({
      searchDocuments: vi.fn().mockRejectedValue(new Error('search unavailable')),
      listDocumentBlocks: vi
        .fn()
        .mockResolvedValue([
          {
            id: 'release-block',
            documentId: 'doc-2',
            blockType: 'paragraph',
            blockIndex: 0,
            plainText: related.plainText,
          },
        ]),
    })

    const context = await buildAgentRunContext({ snapshot, mode: 'ask', document: adapter })

    expect(context.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: 'doc-2', blockId: 'release-block' }),
      ]),
    )
    expect(context.text).toContain('只依据上述来源回答')
    expect(adapter.listDocumentBlocks).toHaveBeenCalledWith('doc-2')
  })

  it('does not search the knowledge base for a direct edit run', async () => {
    const snapshot = createSnapshot([])
    const adapter = createAdapter()

    const context = await buildAgentRunContext({
      snapshot,
      mode: 'edit',
      targetBlocks: snapshot.document.blocks,
      document: adapter,
    })

    expect(context.text).toContain('本次需要修改的目标块')
    expect(adapter.searchDocuments).not.toHaveBeenCalled()
  })

  it('starts agent runs without preloading or searching documents', async () => {
    const snapshot = createSnapshot([
      documentSummary('doc-2', '相关文档', '不应自动注入的相关正文'),
    ])
    const adapter = createAdapter()

    const context = await buildAgentRunContext({
      snapshot,
      mode: 'agent',
      targetBlocks: snapshot.document.blocks,
      document: adapter,
    })

    expect(context.sources).toEqual([])
    expect(context.text).toContain('未预载当前文档或知识库正文')
    expect(context.text).not.toContain(snapshot.document.text)
    expect(context.text).not.toContain('不应自动注入的相关正文')
    expect(adapter.searchDocuments).not.toHaveBeenCalled()
    expect(adapter.listDocumentBlocks).not.toHaveBeenCalled()
  })

  it('injects an explicitly targeted knowledge asset into a research context', async () => {
    const snapshot = createSnapshot([])
    snapshot.explicitTargets = [
      {
        kind: 'knowledge_asset',
        id: 'asset-1',
        title: '季度复盘.pdf',
        content: '营收增长来自续费率改善，但样本只覆盖企业客户。',
      },
      {
        kind: 'knowledge_asset',
        id: 'asset-2',
        title: '客户访谈.docx',
        content: '中小客户认为续费流程仍然复杂。',
      },
    ]

    const context = await buildAgentRunContext({
      snapshot,
      mode: 'agent',
      document: createAdapter(),
    })

    expect(context.text).toContain('显式目标数量：2')
    expect(context.text).toContain('目标 1：季度复盘.pdf')
    expect(context.text).toContain('目标 2：客户访谈.docx')
    expect(context.text).toContain('营收增长来自续费率改善')
    expect(context.text).toContain('不得伪造 Evidence 来源')
  })
})

function createSnapshot(documents: DocumentSummary[]): AgentRunSnapshot {
  const settings = createAiSettings('openai')
  settings.model = 'test-model'
  return {
    prompt: '发布流程中的灰度验证是什么？',
    requestedMode: 'ask',
    settings,
    explicitTargets: [],
    document: {
      id: 'doc-1',
      title: '当前文档',
      tags: [],
      sourceUrl: '',
      author: '',
      text: '当前文档正文',
      markdown: '当前文档正文',
      revision: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: '当前文档正文', index: 0 }],
      selectedBlocks: [],
      hasBlockSelection: false,
      documents,
    },
  }
}
function createAdapter(overrides: Partial<AgentRunDocumentAdapter> = {}): AgentRunDocumentAdapter {
  return {
    captureSnapshot: () => createSnapshot([]).document,
    flushBeforeEdit: async () => ({ ok: true, revision: 1 }),
    searchDocuments: vi.fn().mockResolvedValue([]),
    readDocument: async () => null,
    listDocumentBlocks: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function documentSummary(id: string, title: string, plainText: string): DocumentSummary {
  return {
    id,
    parentId: null,
    documentKind: 'article',
    title,
    tags: [],
    sourceUrl: '',
    author: '',
    description: '',
    plainText,
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}
