import { describe, expect, it } from 'vitest'

import {
  appendKnowledgeSources,
  anchorKnowledgeRetrievalResult,
  buildKnowledgeRetrievalContext,
  type KnowledgeSource,
} from './knowledgeRetrieval'
import type { DocumentSummary } from './document'

function createDocument(
  input: Partial<DocumentSummary> & { id: string; title: string; plainText: string },
): DocumentSummary {
  return {
    id: input.id,
    parentId: null,
    documentKind: input.documentKind ?? 'article',
    title: input.title,
    tags: input.tags ?? [],
    sourceUrl: '',
    author: '',
    description: '',
    plainText: input.plainText,
    revision: 1,
    sortOrder: 0,
    isDeleted: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('knowledge retrieval', () => {
  it('always includes the current document and ranks matching knowledge documents', () => {
    const result = buildKnowledgeRetrievalContext({
      query: '差旅报销 住宿 标准',
      currentDocumentId: 'current',
      currentDocumentTitle: '当前会议纪要',
      currentDocumentText: '今天讨论了报销流程。',
      documents: [
        createDocument({
          id: 'current',
          title: '当前会议纪要',
          plainText: '今天讨论了报销流程。',
        }),
        createDocument({
          id: 'travel',
          title: '差旅报销制度',
          plainText: '上海住宿标准为 600 元以内，报销需要发票和行程单。',
        }),
        createDocument({
          id: 'security',
          title: '信息安全制度',
          plainText: '电脑需要开启磁盘加密。',
        }),
      ],
    })

    expect(result.sources.map((source) => source.documentId)).toEqual(['current', 'travel'])
    expect(result.context).toContain('[S2]')
    expect(result.context).toContain('差旅报销制度')
  })

  it('appends clickable markdown source links', () => {
    const sources: KnowledgeSource[] = [
      {
        id: 'S1',
        documentId: 'doc-1',
        documentTitle: '差旅报销制度',
        contentSnippet: '住宿标准为 600 元以内。',
        score: 10,
        isCurrentDocument: false,
      },
    ]

    expect(appendKnowledgeSources('答案', sources)).toContain(
      '[S1] [差旅报销制度](#document=doc-1)',
    )
  })

  it('anchors a source to its best matching stable block', () => {
    const result = buildKnowledgeRetrievalContext({
      query: '住宿标准',
      currentDocumentId: 'current',
      currentDocumentTitle: '问题',
      currentDocumentText: '询问制度',
      documents: [
        createDocument({
          id: 'travel',
          title: '差旅制度',
          plainText: '交通要求。住宿标准为 600 元。',
        }),
      ],
    })
    const anchored = anchorKnowledgeRetrievalResult(
      result,
      '住宿标准',
      new Map([
        ['current', [{ id: 'q1', index: 0, plainText: '询问制度' }]],
        [
          'travel',
          [
            { id: 't1', index: 0, plainText: '交通要求' },
            { id: 't2', index: 1, plainText: '住宿标准为 600 元' },
          ],
        ],
      ]),
    )
    expect(anchored.sources.find((source) => source.documentId === 'travel')?.blockId).toBe('t2')
    expect(appendKnowledgeSources('答案', anchored.sources)).toContain('&block=t2')
  })

  it('filters weakly related documents when a strong source is available', () => {
    const result = buildKnowledgeRetrievalContext({
      query: '我要采购 35000 元的软件订阅，需要谁审批，新增供应商要准备什么材料',
      currentDocumentId: 'current',
      currentDocumentTitle: '员工问题',
      currentDocumentText: '询问采购审批。',
      documents: [
        createDocument({
          id: 'current',
          title: '员工问题',
          plainText: '询问采购审批。',
        }),
        createDocument({
          id: 'procurement',
          title: '采购与供应商制度',
          plainText:
            '采购金额 30000 元以上必须由 CFO 审批。新增供应商需要营业执照、银行账户信息和合同模板。',
        }),
        createDocument({
          id: 'security-report',
          title: '网络安全评估报告',
          plainText: '某软件服务存在版本暴露风险，需要安排修复。',
        }),
      ],
    })

    expect(result.sources.map((source) => source.documentId)).toEqual(['current', 'procurement'])
  })
})
