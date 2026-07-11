import type { AiChatMode } from '@/models/aiChatMode'
import type { SelectedBlock } from '@/models/agent'
import {
  anchorKnowledgeRetrievalResult,
  buildKnowledgeRetrievalContext,
  type KnowledgeSource,
} from '@/models/knowledgeRetrieval'
import { normalizeDocumentTitle } from '@/features/documents/documentPresentation'
import type { AgentRunDocumentAdapter, AgentRunSnapshot } from './types'

export async function buildAgentRunContext(input: {
  snapshot: AgentRunSnapshot
  mode: AiChatMode
  targetBlocks?: SelectedBlock[]
  document: AgentRunDocumentAdapter
}): Promise<{ text: string; sources: KnowledgeSource[] }> {
  const { snapshot, mode } = input
  const document = snapshot.document
  const targetBlocks = input.targetBlocks ?? []
  const lines = [
    '标题：' + normalizeDocumentTitle(document.title),
    '标签：' + (document.tags.join('、') || '无'),
    '来源：' + (document.sourceUrl || '无'),
    '作者：' + (document.author || '无'),
    '',
    '正文：',
    document.text,
  ]
  if (targetBlocks.length > 0) {
    lines.push(
      '',
      '本次需要修改的目标块：',
      ...targetBlocks.map((block, index) =>
        [`[${index + 1}] id=${block.id} type=${block.type}`, block.text || '（空块）'].join('\n'),
      ),
    )
  }

  let retrieval = null
  if (mode === 'ask' || mode === 'agent') {
    let searched
    try {
      searched = await input.document.searchDocuments(snapshot.prompt, 5)
    } catch {
      searched = document.documents
    }
    retrieval = buildKnowledgeRetrievalContext({
      query: snapshot.prompt,
      documents: searched,
      currentDocumentId: document.id,
      currentDocumentTitle: normalizeDocumentTitle(document.title),
      currentDocumentText: document.text,
      maxSources: 5,
    })
    if (retrieval.sources.length > 0) {
      const blocksByDocumentId = new Map()
      blocksByDocumentId.set(
        document.id,
        document.blocks.map((block) => ({ id: block.id, index: block.index, plainText: block.text })),
      )
      await Promise.all(
        retrieval.sources
          .filter((source) => source.documentId !== document.id)
          .map(async (source) => {
            const blocks = await input.document.listDocumentBlocks(source.documentId)
            blocksByDocumentId.set(source.documentId, blocks)
          }),
      )
      retrieval = anchorKnowledgeRetrievalResult(retrieval, snapshot.prompt, blocksByDocumentId)
    }
  }

  const sources = retrieval?.sources ?? []
  if (sources.length > 0) {
    lines.push(
      '',
      '本次任务使用的文档来源：',
      retrieval?.context ?? '',
      '',
      '回答要求：只依据上述来源回答。涉及知识库内容时，在相关句子后标注来源编号，例如 [S2]。来源未提供的执行细节必须明确写“资料未提供”，不要补充常识或猜测。',
    )
  }
  return { text: lines.join('\n'), sources }
}
