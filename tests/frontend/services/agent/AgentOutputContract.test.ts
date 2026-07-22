import { describe, expect, it } from 'vitest'

import {
  COGNITIVE_TEST_OUTPUT_CONTRACT,
  LEARNING_OUTPUT_CONTRACT,
  RESEARCH_OUTPUT_CONTRACT,
  REVIEW_OUTPUT_CONTRACT,
} from '@/services/cognitive/CognitiveRegistry'
import {
  formatAgentOutputContractInstruction,
  validateAgentOutputContract,
} from '@/services/agent/AgentOutputContract'

describe('AgentOutputContract', () => {
  it('gives the model the exact schema without inviting type placeholders', () => {
    const instruction = formatAgentOutputContractInstruction(REVIEW_OUTPUT_CONTRACT)

    expect(instruction).toContain('JSON Schema')
    expect(instruction).toContain('"required":["summary","issues","unresolvedQuestions"]')
    expect(instruction).toContain('"maxItems":0')
    expect(instruction).toContain('不得输出类型占位符')
  })

  it('validates a cognitive JSON contract independently from the legacy patch protocol', () => {
    expect(
      validateAgentOutputContract(
        COGNITIVE_TEST_OUTPUT_CONTRACT,
        '```json\n{"summary":"完成","items":[{"kind":"claim","text":"结论"}]}\n```',
      ),
    ).toEqual({ summary: '完成', items: [{ kind: 'claim', text: '结论' }] })
    expect(() =>
      validateAgentOutputContract(COGNITIVE_TEST_OUTPUT_CONTRACT, '{"commands":[]}'),
    ).toThrow()
  })

  it('keeps evidence distinct and requires stable source provenance', () => {
    const result = validateAgentOutputContract(
      RESEARCH_OUTPUT_CONTRACT,
      JSON.stringify({
        summary: '一项有来源的结论和一个未解决问题。',
        items: [
          {
            id: 'E1',
            kind: 'evidence',
            title: '原文证据',
            content: '文档明确记录了该事实。',
            confidence: 0.9,
            validationStatus: 'verified',
            validationMessage: '来源可定位。',
            sources: [{ documentId: 'doc-1', blockId: 'block-1', revision: 3, quote: '原文片段' }],
          },
        ],
        relations: [],
        unresolvedQuestions: ['是否存在更新版本？'],
      }),
    )

    expect(result.items[0]?.sources[0]).toMatchObject({ blockId: 'block-1', revision: 3 })
    expect(() =>
      RESEARCH_OUTPUT_CONTRACT.validate({
        ...result,
        items: [{ ...result.items[0], sources: [] }],
      }),
    ).toThrow('Evidence 必须有可定位来源')
  })

  it('rejects dangling relation proposals', () => {
    expect(() =>
      RESEARCH_OUTPUT_CONTRACT.validate({
        summary: '关系校验',
        items: [],
        relations: [
          {
            fromItemId: 'missing-a',
            relationType: 'supports',
            toItemId: 'missing-b',
            explanation: '无效引用',
          },
        ],
        unresolvedQuestions: [],
      }),
    ).toThrow('关系必须引用本次结果条目')
  })

  it('enforces deterministic Review conflict and missing-source classification', () => {
    const baseIssue = {
      id: 'I1',
      severity: 'warning',
      title: '问题',
      explanation: '说明',
      affectedText: '原文',
      suggestedAction: '补充说明',
      sourceState: 'unverified',
    } as const
    expect(() =>
      REVIEW_OUTPUT_CONTRACT.validate({
        summary: '发现冲突',
        issues: [
          {
            ...baseIssue,
            issueType: 'conflict',
            sources: [{ documentId: 'doc-1', blockId: 'block-1', revision: 1, quote: '唯一来源' }],
          },
        ],
        unresolvedQuestions: [],
      }),
    ).toThrow('conflict 必须定位至少两个不同来源')
    expect(() =>
      REVIEW_OUTPUT_CONTRACT.validate({
        summary: '无来源结论',
        issues: [{ ...baseIssue, issueType: 'unsupported_claim', sources: [] }],
        unresolvedQuestions: [],
      }),
    ).toThrow('完全无来源的结论必须分类为 missing_source')
    expect(
      REVIEW_OUTPUT_CONTRACT.validate({
        summary: '无来源结论',
        issues: [{ ...baseIssue, issueType: 'missing_source', sources: [] }],
        unresolvedQuestions: [],
      }).issues[0],
    ).toMatchObject({ issueType: 'missing_source', sourceState: 'unverified' })
  })

  it('rejects Learning feedback before any attempt and requires a next prompt while waiting', () => {
    const initial = {
      phase: 'waiting_user',
      feedback: { correctPoints: [], omissions: [], misconceptions: [] },
      understandingState: 'not_assessed',
      evidence: '',
      nextPrompt: { kind: 'question', content: '请先解释。', hintLevel: 0 },
      candidateUnderstanding: null,
    } as const
    expect(LEARNING_OUTPUT_CONTRACT.validate(initial)).toMatchObject({
      understandingState: 'not_assessed',
    })
    expect(() =>
      LEARNING_OUTPUT_CONTRACT.validate({
        ...initial,
        feedback: { correctPoints: ['尚未作答却被判为正确'], omissions: [], misconceptions: [] },
      }),
    ).toThrow('尚无用户尝试时不能生成理解反馈')
    expect(() =>
      LEARNING_OUTPUT_CONTRACT.validate({
        ...initial,
        nextPrompt: { kind: 'none', content: '', hintLevel: 0 },
      }),
    ).toThrow('waiting_user 必须提供下一条问题')
  })
})
