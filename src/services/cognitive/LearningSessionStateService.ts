import type { LearningSessionState, LearningTurnResult } from '@/models/cognitive/cognitive'
import { err, ok, type AppResult } from '@/models/shared/result'

export function createLearningSessionState(topic: string): LearningSessionState {
  return {
    version: 1,
    topic: topic.trim(),
    currentPrompt: '',
    promptKind: 'question',
    hintLevel: 0,
    attempts: [],
    understandingState: 'not_assessed',
    nextStep: 'await_attempt',
  }
}

export function createInitialLearningTurn(topic: string): LearningTurnResult {
  const normalizedTopic = topic.trim() || '当前主题'
  return {
    phase: 'waiting_user',
    feedback: { correctPoints: [], omissions: [], misconceptions: [] },
    understandingState: 'not_assessed',
    evidence: '',
    nextPrompt: {
      kind: 'question',
      content: `请先用自己的话解释你对“${normalizedTopic}”的当前理解，也可以指出最不确定的部分。`,
      hintLevel: 0,
    },
    candidateUnderstanding: null,
  }
}

export function parseLearningSessionState(value: unknown): LearningSessionState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<LearningSessionState>
  if (
    state.version !== 1 ||
    typeof state.topic !== 'string' ||
    typeof state.currentPrompt !== 'string' ||
    !Number.isInteger(state.hintLevel) ||
    Number(state.hintLevel) < 0 ||
    Number(state.hintLevel) > 3 ||
    !Array.isArray(state.attempts) ||
    !state.attempts.every(isLearningAttempt) ||
    !isUnderstandingState(state.understandingState) ||
    ![
      'question',
      'guided_question',
      'hint',
      'counterexample',
      'transfer_question',
      'none',
    ].includes(state.promptKind ?? '') ||
    !['await_attempt', 'continue', 'complete', 'needs_review'].includes(state.nextStep ?? '')
  ) {
    return null
  }
  return state as LearningSessionState
}

function isLearningAttempt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const attempt = value as LearningSessionState['attempts'][number]
  return (
    typeof attempt.id === 'string' &&
    typeof attempt.response === 'string' &&
    Boolean(attempt.feedback && typeof attempt.feedback === 'object') &&
    isStringArray(attempt.feedback.correctPoints) &&
    isStringArray(attempt.feedback.omissions) &&
    isStringArray(attempt.feedback.misconceptions) &&
    isUnderstandingState(attempt.understandingState) &&
    typeof attempt.evidence === 'string' &&
    Number.isFinite(attempt.createdAt)
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isUnderstandingState(value: unknown): boolean {
  return ['not_assessed', 'partial', 'misconception', 'demonstrated', 'needs_review'].includes(
    typeof value === 'string' ? value : '',
  )
}

export function compileLearningStateContext(
  state: LearningSessionState,
  userAttempt: string | null,
): string {
  return [
    'Learning Session 是本轮状态写真源，不要从聊天消息数量推断理解程度。',
    `LearningSessionState: ${JSON.stringify(state)}`,
    userAttempt === null
      ? '当前尚无用户尝试。只提出首个解释题或问题，不提供完整答案。'
      : `本轮用户尝试：${JSON.stringify(userAttempt)}`,
  ].join('\n')
}

export function applyLearningTurn(input: {
  state: LearningSessionState
  userAttempt: string | null
  turn: LearningTurnResult
  createId: () => string
  now?: number
}): AppResult<LearningSessionState> {
  const initialTurn = input.state.attempts.length === 0 && input.userAttempt === null
  if (initialTurn) {
    if (
      input.turn.phase !== 'waiting_user' ||
      input.turn.understandingState !== 'not_assessed' ||
      !['question', 'guided_question'].includes(input.turn.nextPrompt.kind) ||
      input.turn.nextPrompt.hintLevel !== 0 ||
      input.turn.candidateUnderstanding !== null
    ) {
      return err({
        code: 'validation-error',
        message: '首次 Learning turn 必须先等待用户尝试，不能评定理解或给出候选理解记录。',
      })
    }
    return ok({
      ...input.state,
      currentPrompt: input.turn.nextPrompt.content,
      promptKind: input.turn.nextPrompt.kind,
      hintLevel: 0,
      understandingState: 'not_assessed',
      nextStep: 'await_attempt',
    })
  }

  const response = input.userAttempt?.trim() ?? ''
  if (!response) {
    return err({ code: 'validation-error', message: 'Learning 分析缺少本轮用户尝试。' })
  }
  if (input.turn.understandingState === 'not_assessed' || !input.turn.evidence.trim()) {
    return err({
      code: 'validation-error',
      message: '理解状态变化必须引用本轮用户尝试的可见证据。',
    })
  }
  if (
    (input.turn.phase === 'waiting_user' && input.turn.nextPrompt.kind === 'none') ||
    (input.turn.phase === 'completed' && input.turn.nextPrompt.kind !== 'none')
  ) {
    return err({
      code: 'validation-error',
      message: 'Learning phase 与下一步提示不一致。',
    })
  }
  if (
    input.turn.phase === 'completed' &&
    !['demonstrated', 'needs_review'].includes(input.turn.understandingState)
  ) {
    return err({
      code: 'validation-error',
      message: '只有 demonstrated 或 needs_review 可以结束 Learning Session。',
    })
  }
  const expectedHintLevel =
    input.turn.nextPrompt.kind === 'hint'
      ? Math.min(3, input.state.hintLevel + 1)
      : input.state.hintLevel
  if (input.turn.nextPrompt.hintLevel !== expectedHintLevel) {
    return err({
      code: 'validation-error',
      message: '提示层级必须逐级增加，非提示步骤不能静默改变层级。',
    })
  }
  const attempt = {
    id: input.createId(),
    response,
    feedback: input.turn.feedback,
    understandingState: input.turn.understandingState,
    evidence: input.turn.evidence.trim(),
    createdAt: input.now ?? Date.now(),
  }
  return ok({
    ...input.state,
    currentPrompt: input.turn.nextPrompt.content,
    promptKind: input.turn.nextPrompt.kind,
    hintLevel: input.turn.nextPrompt.hintLevel,
    attempts: [...input.state.attempts, attempt],
    understandingState: input.turn.understandingState,
    nextStep:
      input.turn.phase === 'waiting_user'
        ? 'continue'
        : input.turn.understandingState === 'needs_review'
          ? 'needs_review'
          : 'complete',
  })
}
