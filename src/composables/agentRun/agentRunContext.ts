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
  const documentMarkdown = document.markdown || document.text
  const targetBlocks = input.targetBlocks ?? []
  if (mode === 'agent') {
    if (snapshot.explicitTargets.length > 0) {
      const perTargetLimit = Math.max(1_000, Math.floor(120_000 / snapshot.explicitTargets.length))
      const targetSections = snapshot.explicitTargets.map((target, index) => {
        const rawTargetContent =
          target.content?.trim() ||
          (target.kind === 'document' && target.id === document.id
            ? documentMarkdown
            : '（该目标没有可用的提取文本）')
        const targetContent =
          rawTargetContent.length > perTargetLimit
            ? `${rawTargetContent.slice(0, perTargetLimit)}\n\n（该目标内容较长，本次上下文已截断。）`
            : rawTargetContent
        return [
          `## 目标 ${index + 1}：${target.title}`,
          `目标类型：${target.kind === 'document' ? '知识库文件' : '知识资产'}`,
          target.kind === 'knowledge_asset'
            ? '该目标没有稳定 document/block revision，不得伪造 Evidence 来源；相关结论应标为 unverified。'
            : `目标文档 ID：${target.id}；revision：${target.revision ?? '未知'}`,
          '',
          targetContent,
        ].join('\n')
      })
      return {
        text: [
          `当前 Agent 项目：${snapshot.workspace?.projectName ?? '未分组项目'}`,
          `显式目标数量：${snapshot.explicitTargets.length}`,
          '这是多文件 Research。必须逐份分析，并比较共同点、差异、冲突、证据强弱与缺失信息。',
          '',
          ...targetSections,
          '',
          '本次任务必须以以上显式目标集合为边界，不得把当前打开页面替换或混入研究目标。',
        ].join('\n'),
        sources: [],
      }
    }
    return {
      text: [
        `当前 Agent 项目：${snapshot.workspace?.projectName ?? '未分组项目'}`,
        `项目工作区根范围：${snapshot.workspace?.rootDocumentIds.join('、') || '未限制'}`,
        '本次 Agent 任务未预载当前文档或知识库正文。',
        '需要页面内容、选中块、文档大纲或知识库资料时，请按任务需要调用对应的只读工具。',
        '知识库检索默认限定项目工作区；若工作区证据不足，可以显式扩大到全库搜索。',
      ].join('\n'),
      sources: [],
    }
  }
  const lines = [
    'Agent 项目：' + (snapshot.workspace?.projectName ?? '未分组项目'),
    '工作区根范围：' + (snapshot.workspace?.rootDocumentIds.join('、') || '未限制'),
    '标题：' + normalizeDocumentTitle(document.title),
    '标签：' + (document.tags.join('、') || '无'),
    '来源：' + (document.sourceUrl || '无'),
    '作者：' + (document.author || '无'),
    '',
    '正文（Markdown）：',
    documentMarkdown,
  ]
  if (targetBlocks.length > 0) {
    lines.push(
      '',
      '本次需要修改的目标块：',
      ...targetBlocks.map((block, index) =>
        [
          `[${index + 1}] id=${block.id} type=${block.type}`,
          block.markdown || block.text || '（空块）',
        ].join('\n'),
      ),
    )
  }

  let retrieval = null
  if (mode === 'ask') {
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
      currentDocumentText: documentMarkdown,
      maxSources: 5,
    })
    if (retrieval.sources.length > 0) {
      const blocksByDocumentId = new Map()
      blocksByDocumentId.set(
        document.id,
        document.blocks.map((block) => ({
          id: block.id,
          index: block.index,
          plainText: block.text,
        })),
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

  const sources = (retrieval?.sources ?? []).map((source) =>
    source.documentId === document.id
      ? { ...source, revision: document.revision ?? source.revision }
      : source,
  )
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
