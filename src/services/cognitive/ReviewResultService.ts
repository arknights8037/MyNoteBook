import type { ReviewIssue, ReviewResult } from '@/models/cognitive/cognitive'
import type { DocumentBlock } from '@/models/documents/documentBlock'
import type { DocumentRecord } from '@/models/documents/document'

export interface ReviewSourceReader {
  readDocument(documentId: string): Promise<DocumentRecord | null>
  listDocumentBlocks(documentId: string): Promise<DocumentBlock[]>
}

export async function validateReviewResultSources(input: {
  result: ReviewResult
  reader: ReviewSourceReader
  createId: () => string
}): Promise<ReviewResult> {
  const issues: ReviewIssue[] = []
  for (const issue of input.result.issues) {
    if (issue.sources.length === 0) {
      issues.push({ ...issue, sourceState: 'unverified' })
      continue
    }
    const staleSources = []
    for (const source of issue.sources) {
      const document = await input.reader.readDocument(source.documentId)
      const blocks = document ? await input.reader.listDocumentBlocks(source.documentId) : []
      if (
        !document ||
        document.revision !== source.revision ||
        !blocks.some((block) => block.id === source.blockId)
      ) {
        staleSources.push(source)
      }
    }
    issues.push({ ...issue, sourceState: staleSources.length > 0 ? 'stale' : 'fresh' })
    if (staleSources.length > 0 && issue.issueType !== 'outdated_information') {
      issues.push({
        id: input.createId(),
        issueType: 'outdated_information',
        severity: 'error',
        title: `来源已变化：${issue.title}`,
        explanation: '该问题引用的文档 revision 或稳定 block 已失效，现有判断不能直接沿用。',
        affectedText: staleSources.map((source) => source.quote).join('\n'),
        suggestedAction: '重新读取当前来源并再次执行 Review。',
        sources: staleSources,
        sourceState: 'stale',
      })
    }
  }
  return { ...input.result, issues }
}

export function buildReviewIssueResolutionPrompt(issue: ReviewIssue): string {
  const sourceSummary = issue.sources
    .map((source) => `${source.documentId}/${source.blockId}@r${source.revision}: ${source.quote}`)
    .join('\n')
  return [
    '/edit 请针对以下已确认的 Review 问题生成最小、可确认的修改提案。',
    `问题类型：${issue.issueType}`,
    `标题：${issue.title}`,
    `说明：${issue.explanation}`,
    issue.affectedText ? `涉及内容：${issue.affectedText}` : '',
    `建议动作：${issue.suggestedAction}`,
    sourceSummary ? `Review 来源：\n${sourceSummary}` : '',
    '只处理这一项问题；仍需遵守读取 provenance、Patch 校验和用户确认。',
  ]
    .filter(Boolean)
    .join('\n')
}
