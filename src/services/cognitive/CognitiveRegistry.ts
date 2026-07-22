import { z } from 'zod'

import type {
  CognitiveModeDefinition,
  KnowledgeControlTemplate,
  LearningTurnResult,
  ResearchResult,
  ReviewResult,
} from '@/models/cognitive/cognitive'
import type { AgentOutputContract } from '@/services/agent/AgentOutputContract'

const testContractSchema = z.object({
  summary: z.string().min(1),
  items: z.array(z.object({ kind: z.string().min(1), text: z.string().min(1) })).default([]),
})

export const COGNITIVE_TEST_OUTPUT_CONTRACT: AgentOutputContract<
  z.infer<typeof testContractSchema>
> = {
  id: 'cognitive-test',
  version: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'items'],
    properties: {
      summary: { type: 'string', minLength: 1 },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text'],
          properties: { kind: { type: 'string' }, text: { type: 'string' } },
        },
      },
    },
  },
  systemInstruction:
    '最终只输出符合 cognitive-test v1 的 JSON：summary 为摘要，items 为 kind/text 条目；不要输出 command 或 Patch。',
  validate: (value) => testContractSchema.parse(value),
}

const researchSourceSchema = z.object({
  documentId: z.string().trim().min(1),
  blockId: z.string().trim().min(1),
  revision: z.number().int().positive(),
  quote: z.string().trim().min(1).max(1_000),
})
const researchItemSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.enum([
      'claim',
      'evidence',
      'assumption',
      'inference',
      'limitation',
      'conflict',
      'question',
    ]),
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).nullable(),
    validationStatus: z.enum(['verified', 'warning', 'unverified']),
    validationMessage: z.string().trim().min(1),
    sources: z.array(researchSourceSchema),
  })
  .superRefine((item, context) => {
    if (item.kind === 'evidence' && item.sources.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Evidence 必须有可定位来源。',
      })
    }
    if (item.validationStatus === 'verified' && item.sources.length === 0) {
      context.addIssue({ code: 'custom', path: ['sources'], message: '已验证条目必须有来源。' })
    }
  })
const researchResultSchema = z
  .object({
    summary: z.string().trim().min(1),
    items: z.array(researchItemSchema),
    relations: z.array(
      z.object({
        fromItemId: z.string().trim().min(1),
        relationType: z.enum(['supports', 'conflicts_with', 'derives_from', 'relates_to']),
        toItemId: z.string().trim().min(1),
        explanation: z.string().trim().min(1),
      }),
    ),
    unresolvedQuestions: z.array(z.string().trim().min(1)),
  })
  .superRefine((result, context) => {
    const ids = new Set(result.items.map((item) => item.id))
    if (ids.size !== result.items.length) {
      context.addIssue({ code: 'custom', path: ['items'], message: 'Research item id 必须唯一。' })
    }
    result.relations.forEach((relation, index) => {
      if (!ids.has(relation.fromItemId) || !ids.has(relation.toItemId)) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index],
          message: '关系必须引用本次结果条目。',
        })
      }
      if (relation.fromItemId === relation.toItemId) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index],
          message: '关系不能指向自身。',
        })
      }
    })
  })

export const RESEARCH_OUTPUT_CONTRACT: AgentOutputContract<ResearchResult> = {
  id: 'research-result',
  version: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'items', 'relations', 'unresolvedQuestions'],
    properties: {
      summary: { type: 'string', minLength: 1 },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'kind',
            'title',
            'content',
            'confidence',
            'validationStatus',
            'validationMessage',
            'sources',
          ],
          properties: {
            id: { type: 'string', minLength: 1 },
            kind: {
              enum: [
                'claim',
                'evidence',
                'assumption',
                'inference',
                'limitation',
                'conflict',
                'question',
              ],
            },
            title: { type: 'string', minLength: 1 },
            content: { type: 'string', minLength: 1 },
            confidence: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
            validationStatus: { enum: ['verified', 'warning', 'unverified'] },
            validationMessage: { type: 'string', minLength: 1 },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['documentId', 'blockId', 'revision', 'quote'],
                properties: {
                  documentId: { type: 'string', minLength: 1 },
                  blockId: { type: 'string', minLength: 1 },
                  revision: { type: 'integer', minimum: 1 },
                  quote: { type: 'string', minLength: 1, maxLength: 1000 },
                },
              },
            },
          },
        },
      },
      relations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fromItemId', 'relationType', 'toItemId', 'explanation'],
          properties: {
            fromItemId: { type: 'string', minLength: 1 },
            relationType: { enum: ['supports', 'conflicts_with', 'derives_from', 'relates_to'] },
            toItemId: { type: 'string', minLength: 1 },
            explanation: { type: 'string', minLength: 1 },
          },
        },
      },
      unresolvedQuestions: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  },
  systemInstruction:
    '最终只输出符合 research-result v1 的 JSON。Claim 与 Evidence 必须分开；Evidence 必须含 documentId、blockId、revision 和原文 quote。无可定位来源的内容只能标为 unverified claim、assumption、limitation 或 question，不能伪装成 Evidence。不要输出 command、Patch 或 Markdown 代码围栏。',
  validate: (value) => researchResultSchema.parse(value),
}

const reviewIssueTypes = [
  'unsupported_claim',
  'missing_source',
  'logical_gap',
  'conflict',
  'undefined_term',
  'missing_scope_or_assumption',
  'outdated_information',
  'evidence_mismatch',
  'ambiguity',
] as const
const reviewIssueSchema = z
  .object({
    id: z.string().trim().min(1),
    issueType: z.enum(reviewIssueTypes),
    severity: z.enum(['info', 'warning', 'error']),
    title: z.string().trim().min(1),
    explanation: z.string().trim().min(1),
    affectedText: z.string().trim(),
    suggestedAction: z.string().trim().min(1),
    sources: z.array(researchSourceSchema),
    sourceState: z.enum(['fresh', 'stale', 'unverified']).default('unverified'),
  })
  .superRefine((issue, context) => {
    const uniqueSources = new Set(
      issue.sources.map((source) => `${source.documentId}:${source.blockId}:${source.revision}`),
    )
    if (issue.issueType === 'missing_source' && issue.sources.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'missing_source 问题不能携带声称支持该结论的来源。',
      })
    }
    if (issue.issueType === 'unsupported_claim' && issue.sources.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['issueType'],
        message: '完全无来源的结论必须分类为 missing_source。',
      })
    }
    if (issue.issueType === 'conflict' && uniqueSources.size < 2) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'conflict 必须定位至少两个不同来源。',
      })
    }
    if (
      (issue.issueType === 'outdated_information' || issue.issueType === 'evidence_mismatch') &&
      issue.sources.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: `${issue.issueType} 必须携带可定位来源。`,
      })
    }
  })
const reviewResultSchema = z
  .object({
    summary: z.string().trim().min(1),
    issues: z.array(reviewIssueSchema),
    unresolvedQuestions: z.array(z.string().trim().min(1)),
  })
  .superRefine((result, context) => {
    const ids = new Set(result.issues.map((issue) => issue.id))
    if (ids.size !== result.issues.length) {
      context.addIssue({ code: 'custom', path: ['issues'], message: 'Review issue id 必须唯一。' })
    }
  })

export const REVIEW_OUTPUT_CONTRACT: AgentOutputContract<ReviewResult> = {
  id: 'review-result',
  version: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'issues', 'unresolvedQuestions'],
    properties: {
      summary: { type: 'string', minLength: 1 },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'issueType',
            'severity',
            'title',
            'explanation',
            'affectedText',
            'suggestedAction',
            'sources',
          ],
          allOf: [
            {
              if: { properties: { issueType: { const: 'missing_source' } } },
              then: { properties: { sources: { maxItems: 0 } } },
            },
            {
              if: { properties: { issueType: { const: 'unsupported_claim' } } },
              then: { properties: { sources: { minItems: 1 } } },
            },
            {
              if: { properties: { issueType: { const: 'conflict' } } },
              then: { properties: { sources: { minItems: 2 } } },
            },
            {
              if: {
                properties: {
                  issueType: { enum: ['outdated_information', 'evidence_mismatch'] },
                },
              },
              then: { properties: { sources: { minItems: 1 } } },
            },
          ],
          properties: {
            id: { type: 'string', minLength: 1 },
            issueType: { enum: [...reviewIssueTypes] },
            severity: { enum: ['info', 'warning', 'error'] },
            title: { type: 'string', minLength: 1 },
            explanation: { type: 'string', minLength: 1 },
            affectedText: { type: 'string' },
            suggestedAction: { type: 'string', minLength: 1 },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['documentId', 'blockId', 'revision', 'quote'],
                properties: {
                  documentId: { type: 'string', minLength: 1 },
                  blockId: { type: 'string', minLength: 1 },
                  revision: { type: 'integer', minimum: 1 },
                  quote: { type: 'string', minLength: 1, maxLength: 1000 },
                },
              },
            },
            sourceState: { enum: ['fresh', 'stale', 'unverified'] },
          },
        },
      },
      unresolvedQuestions: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  },
  systemInstruction:
    '最终只输出符合 review-result v1 的 JSON。只报告可解释的问题，不生成 command、Patch 或知识候选。完全无来源的结论使用 missing_source，且 missing_source.sources 必须是空数组；unsupported_claim 至少携带一个来源；conflict 必须指向至少两个不同 document/block/revision 来源；outdated_information 和 evidence_mismatch 必须带可定位来源。suggestedAction 只描述建议，不直接修改原文。不要输出 Markdown 代码围栏。',
  validate: (value) => reviewResultSchema.parse(value),
}

const learningFeedbackSchema = z.object({
  correctPoints: z.array(z.string().trim().min(1)),
  omissions: z.array(z.string().trim().min(1)),
  misconceptions: z.array(z.string().trim().min(1)),
})
const learningPromptKinds = [
  'question',
  'guided_question',
  'hint',
  'counterexample',
  'transfer_question',
  'none',
] as const
const learningTurnSchema = z
  .object({
    phase: z.enum(['waiting_user', 'completed']),
    feedback: learningFeedbackSchema,
    understandingState: z.enum([
      'not_assessed',
      'partial',
      'misconception',
      'demonstrated',
      'needs_review',
    ]),
    evidence: z.string().trim(),
    nextPrompt: z.object({
      kind: z.enum(learningPromptKinds),
      content: z.string().trim(),
      hintLevel: z.number().int().min(0).max(3),
    }),
    candidateUnderstanding: z
      .object({
        title: z.string().trim().min(1),
        content: z.string().trim().min(1),
        confidence: z.number().min(0).max(1),
      })
      .nullable(),
  })
  .superRefine((turn, context) => {
    if (
      turn.phase === 'waiting_user' &&
      (turn.nextPrompt.kind === 'none' || !turn.nextPrompt.content)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextPrompt'],
        message: 'waiting_user 必须提供下一条问题、提示、反例或迁移题。',
      })
    }
    if (turn.phase === 'completed' && turn.nextPrompt.kind !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['nextPrompt', 'kind'],
        message: 'completed 不能继续要求用户回答。',
      })
    }
    if (
      turn.understandingState === 'not_assessed' &&
      (turn.feedback.correctPoints.length > 0 ||
        turn.feedback.omissions.length > 0 ||
        turn.feedback.misconceptions.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['feedback'],
        message: '尚无用户尝试时不能生成理解反馈。',
      })
    }
  })

export const LEARNING_OUTPUT_CONTRACT: AgentOutputContract<LearningTurnResult> = {
  id: 'learning-turn',
  version: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'phase',
      'feedback',
      'understandingState',
      'evidence',
      'nextPrompt',
      'candidateUnderstanding',
    ],
    properties: {
      phase: { enum: ['waiting_user', 'completed'] },
      feedback: {
        type: 'object',
        additionalProperties: false,
        required: ['correctPoints', 'omissions', 'misconceptions'],
        properties: {
          correctPoints: { type: 'array', items: { type: 'string', minLength: 1 } },
          omissions: { type: 'array', items: { type: 'string', minLength: 1 } },
          misconceptions: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
      understandingState: {
        enum: ['not_assessed', 'partial', 'misconception', 'demonstrated', 'needs_review'],
      },
      evidence: { type: 'string' },
      nextPrompt: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'content', 'hintLevel'],
        properties: {
          kind: { enum: [...learningPromptKinds] },
          content: { type: 'string' },
          hintLevel: { type: 'integer', minimum: 0, maximum: 3 },
        },
      },
      candidateUnderstanding: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'content', 'confidence'],
            properties: {
              title: { type: 'string', minLength: 1 },
              content: { type: 'string', minLength: 1 },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        ],
      },
    },
  },
  systemInstruction:
    '最终只输出符合 learning-turn v1 的 JSON。首次尚无用户尝试时，只提出要求用户用自己的话解释或作答的问题：understandingState=not_assessed、feedback 为空、phase=waiting_user，禁止给出完整标准答案。收到尝试后，分别指出正确点、遗漏和误解，并以用户原话或行为摘要作为 evidence。可使用 guided_question、逐级 hint、counterexample 或 transfer_question；不得按消息数量判定掌握。candidateUnderstanding 只是临时建议，不得写入正式知识。不要输出 command、Patch 或 Markdown 代码围栏。',
  validate: (value) => learningTurnSchema.parse(value),
}

export const COGNITIVE_MODES: readonly CognitiveModeDefinition[] = [
  createMode('research', 'Research', false, [
    'document.read',
    'knowledge.read',
    'knowledge.validate',
    'external.read',
    'system.inspect',
    'cognition.interact',
  ]),
  createMode('review', 'Review', false, [
    'document.read',
    'knowledge.read',
    'knowledge.validate',
    'external.read',
    'cognition.interact',
  ]),
  createMode('learning', 'Learning', false, [
    'document.read',
    'knowledge.read',
    'cognition.interact',
  ]),
]

export const KNOWLEDGE_CONTROL_TEMPLATES: readonly KnowledgeControlTemplate[] = [
  {
    id: 'research-conclusions',
    name: 'Research Conclusions',
    applicableModes: ['research'],
    extractionRules: [
      {
        kinds: [
          'claim',
          'evidence',
          'assumption',
          'inference',
          'limitation',
          'conflict',
          'question',
        ],
      },
    ],
    validationRules: [{ evidenceRequiresLocatableSource: true }, { verifiedRequiresSource: true }],
    conflictRules: [{ preserveConflictingItems: true }],
    approvalPolicy: { requireExplicitUserApproval: true },
    promptFragments: [
      '区分资料中的直接证据、你的推断与尚未验证的假设。保留冲突和限制，不要为了得到单一结论而抹平差异。',
      '模型输出只是 Research Candidate 输入；未经用户逐项确认，不得成为正式知识。',
    ],
    version: 1,
    enabled: true,
  },
  {
    id: 'review-findings',
    name: 'Review Findings',
    applicableModes: ['review'],
    extractionRules: [{ issueTypes: [...reviewIssueTypes] }],
    validationRules: [
      { sourceRefsUseStableRevision: true },
      { missingSourceHasNoEvidence: true },
      { conflictRequiresTwoSources: true },
    ],
    conflictRules: [{ preserveConflictingSources: true }],
    approvalPolicy: { requireExplicitUserActionForPatch: true },
    promptFragments: [
      'Review 默认只读。区分事实缺陷、逻辑缺口、范围或假设缺失、术语问题、冲突、过期信息、证据不匹配与歧义。',
      '每个问题尽量提供稳定 document/block/revision 来源、严重程度、解释和建议动作；不要自动修改文档或接受知识。',
    ],
    version: 1,
    enabled: true,
  },
  {
    id: 'learning-coach',
    name: 'Learning Coach',
    applicableModes: ['learning'],
    extractionRules: [{ captureUserAttempts: true }, { separateCorrectOmittedMisconception: true }],
    validationRules: [
      { requireAttemptBeforeAssessment: true },
      { requireEvidenceForUnderstandingChange: true },
    ],
    conflictRules: [],
    approvalPolicy: { noAutomaticMastery: true, noFormalKnowledgeWrite: true },
    promptFragments: [
      '先让用户解释或作答，再基于该次尝试分析。优先使用引导问题，提示按 0 到 3 逐级增加；必要时给反例或迁移题。',
      '理解状态只能由当前或历史 LearningAttempt 的可见证据支持，不能按对话轮数推断。needs_review 表示需要以后复习，不等于掌握。',
    ],
    version: 1,
    enabled: true,
  },
  {
    id: 'default-cognitive-control',
    name: 'Default Cognitive Control',
    applicableModes: ['learning', 'research', 'review'],
    extractionRules: [],
    validationRules: [],
    conflictRules: [],
    approvalPolicy: { requireExplicitUserApproval: true },
    promptFragments: ['模型输出只是临时结果；未经用户明确确认，不得成为正式知识。'],
    version: 1,
    enabled: true,
  },
]

export function getCognitiveMode(id: string): CognitiveModeDefinition | null {
  return COGNITIVE_MODES.find((mode) => mode.id === id && mode.enabled) ?? null
}

export function getKnowledgeControlTemplate(id: string): KnowledgeControlTemplate | null {
  return (
    KNOWLEDGE_CONTROL_TEMPLATES.find((template) => template.id === id && template.enabled) ?? null
  )
}

export function getAgentOutputContract(id: string): AgentOutputContract<unknown> | null {
  if (id === RESEARCH_OUTPUT_CONTRACT.id) return RESEARCH_OUTPUT_CONTRACT
  if (id === REVIEW_OUTPUT_CONTRACT.id) return REVIEW_OUTPUT_CONTRACT
  if (id === LEARNING_OUTPUT_CONTRACT.id) return LEARNING_OUTPUT_CONTRACT
  return id === COGNITIVE_TEST_OUTPUT_CONTRACT.id ? COGNITIVE_TEST_OUTPUT_CONTRACT : null
}

function createMode(
  id: CognitiveModeDefinition['id'],
  name: string,
  allowWriteProposals: boolean,
  allowedToolTags: CognitiveModeDefinition['allowedToolTags'],
): CognitiveModeDefinition {
  return {
    id,
    name,
    description: `${name} cognitive policy`,
    interactionPolicy: {
      allowUserInput: true,
      allowWriteProposals,
      ...(id === 'learning' ? { requireUserAttempt: true } : {}),
    },
    contextPolicy: {
      includeCurrentDocument: true,
      includeSelection: true,
      includeEffectiveKnowledge: true,
      includeSessionState: true,
      maxSourceDocuments: id === 'learning' ? 4 : 12,
    },
    outputContractId:
      id === 'research'
        ? RESEARCH_OUTPUT_CONTRACT.id
        : id === 'review'
          ? REVIEW_OUTPUT_CONTRACT.id
          : id === 'learning'
            ? LEARNING_OUTPUT_CONTRACT.id
            : COGNITIVE_TEST_OUTPUT_CONTRACT.id,
    allowedToolTags,
    deniedToolTags: ['document.propose_write', 'knowledge.propose_write', 'external.may_write'],
    defaultSkillIds: [],
    defaultTemplateId:
      id === 'research'
        ? 'research-conclusions'
        : id === 'review'
          ? 'review-findings'
          : id === 'learning'
            ? 'learning-coach'
            : 'default-cognitive-control',
    systemInstructionFragments: [`当前使用 ${name} 认知策略。`],
    version: 1,
    enabled: true,
  }
}
