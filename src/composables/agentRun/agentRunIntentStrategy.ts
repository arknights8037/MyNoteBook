import type { AgentRunIntent } from '@/models/agent/agentSlashCommand'
import type {
  LearningSessionState,
  LearningTurnResult,
  ResearchResult,
  ReviewResult,
} from '@/models/cognitive/cognitive'
import type { DocumentBlock } from '@/models/documents/documentBlock'
import type { DocumentRecord } from '@/models/documents/document'
import { applyLearningTurn } from '@/services/cognitive/LearningSessionStateService'
import { validateReviewResultSources } from '@/services/cognitive/ReviewResultService'

interface CognitiveIntentStrategyInput {
  structuredResult: unknown
  learningState: LearningSessionState | null
  learningUserAttempt: string | null
  document: {
    readDocument: (documentId: string) => Promise<DocumentRecord | null>
    listDocumentBlocks: (documentId: string) => Promise<DocumentBlock[]>
  }
  createId: () => string
}

export interface CognitiveIntentStrategyResult {
  summary: string
  researchResult: ResearchResult | null
  reviewResult: ReviewResult | null
  learningResult: LearningTurnResult | null
  learningState: LearningSessionState | null
}

type CognitiveIntentStrategy = (
  input: CognitiveIntentStrategyInput,
) => Promise<CognitiveIntentStrategyResult>

const strategies: Partial<Record<AgentRunIntent, CognitiveIntentStrategy>> = {
  research: async (input) => {
    const researchResult = input.structuredResult as ResearchResult
    return emptyResult({ researchResult, summary: researchResult.summary })
  },
  review: async (input) => {
    const reviewResult = await validateReviewResultSources({
      result: input.structuredResult as ReviewResult,
      reader: input.document,
      createId: input.createId,
    })
    return emptyResult({ reviewResult, summary: reviewResult.summary })
  },
  learning: async (input) => {
    if (!input.learningState) throw new Error('Learning Session 缺少可恢复状态。')
    const learningResult = input.structuredResult as LearningTurnResult
    const applied = applyLearningTurn({
      state: input.learningState,
      userAttempt: input.learningUserAttempt,
      turn: learningResult,
      createId: input.createId,
    })
    if (!applied.ok) throw new Error(applied.error.message)
    const summary =
      learningResult.understandingState === 'not_assessed'
        ? learningResult.nextPrompt.content
        : `已分析本轮尝试：${learningResult.feedback.correctPoints.length} 个正确点、${learningResult.feedback.omissions.length} 个遗漏、${learningResult.feedback.misconceptions.length} 个误解。`
    return emptyResult({
      learningResult,
      learningState: applied.value,
      summary,
    })
  },
}

export async function resolveCognitiveIntentResult(
  intent: AgentRunIntent,
  input: CognitiveIntentStrategyInput,
): Promise<CognitiveIntentStrategyResult> {
  const strategy = strategies[intent]
  if (!strategy) throw new Error(`认知模式 ${intent} 没有可用的结果策略。`)
  return strategy(input)
}

export function describeAgentRunCompletion(input: {
  hasPatchSet: boolean
  slashIntent?: AgentRunIntent
  intent: AgentRunIntent
  learningResult: LearningTurnResult | null
}): string {
  if (input.hasPatchSet) return '修改提案已准备，等待确认'
  if (input.slashIntent === 'plan') return '计划已完成'
  if (input.intent === 'research') return '调研已完成'
  if (input.intent === 'review') return '审阅已完成'
  if (input.intent === 'learning') {
    return input.learningResult?.phase === 'waiting_user' ? '等待你的尝试' : '学习阶段已完成'
  }
  return '任务已完成'
}

function emptyResult(
  overrides: Partial<CognitiveIntentStrategyResult>,
): CognitiveIntentStrategyResult {
  return {
    summary: '',
    researchResult: null,
    reviewResult: null,
    learningResult: null,
    learningState: null,
    ...overrides,
  }
}
