import { describe, expect, it, vi } from 'vitest'

import type { ReviewResult } from '@/models/cognitive'
import {
  buildReviewIssueResolutionPrompt,
  validateReviewResultSources,
} from './ReviewResultService'

describe('validateReviewResultSources', () => {
  it('marks current document/block sources as fresh', async () => {
    const result = await validateReviewResultSources({
      result: reviewResult(3),
      reader: reader(3, true),
      createId: () => 'generated-1',
    })

    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.sourceState).toBe('fresh')
  })

  it('adds an outdated-information issue when revision provenance is stale', async () => {
    const result = await validateReviewResultSources({
      result: reviewResult(3),
      reader: reader(4, true),
      createId: () => 'generated-outdated',
    })

    expect(result.issues[0]?.sourceState).toBe('stale')
    expect(result.issues[1]).toMatchObject({
      id: 'generated-outdated',
      issueType: 'outdated_information',
      severity: 'error',
      sourceState: 'stale',
    })
  })

  it('keeps missing-source findings explicitly unverified without fabricating sources', async () => {
    const result = await validateReviewResultSources({
      result: {
        summary: '缺少来源',
        issues: [
          {
            id: 'M1',
            issueType: 'missing_source',
            severity: 'warning',
            title: '结论无来源',
            explanation: '没有证据引用。',
            affectedText: '某结论',
            suggestedAction: '补充来源。',
            sources: [],
            sourceState: 'fresh',
          },
        ],
        unresolvedQuestions: [],
      },
      reader: reader(1, true),
      createId: () => 'unused',
    })

    expect(result.issues[0]).toMatchObject({ sourceState: 'unverified', sources: [] })
  })

  it('converts an explicitly selected issue into the existing controlled edit entry', () => {
    const prompt = buildReviewIssueResolutionPrompt(reviewResult(3).issues[0]!)

    expect(prompt).toMatch(/^\/edit /)
    expect(prompt).toContain('evidence_mismatch')
    expect(prompt).toContain('doc-1/block-1@r3')
    expect(prompt).toContain('Patch 校验和用户确认')
  })
})

function reviewResult(revision: number): ReviewResult {
  return {
    summary: '发现问题',
    issues: [
      {
        id: 'I1',
        issueType: 'evidence_mismatch',
        severity: 'warning',
        title: '证据不匹配',
        explanation: '结论超出证据范围。',
        affectedText: '原结论',
        suggestedAction: '缩小结论范围。',
        sources: [{ documentId: 'doc-1', blockId: 'block-1', revision, quote: '来源内容' }],
        sourceState: 'unverified',
      },
    ],
    unresolvedQuestions: [],
  }
}

function reader(revision: number, hasBlock: boolean) {
  return {
    readDocument: vi.fn(async () => ({ revision }) as never),
    listDocumentBlocks: vi.fn(async () => (hasBlock ? ([{ id: 'block-1' }] as never[]) : [])),
  }
}
