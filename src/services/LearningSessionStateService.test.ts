import { describe, expect, it } from 'vitest'

import type { LearningTurnResult } from '@/models/cognitive'
import {
  applyLearningTurn,
  compileLearningStateContext,
  createInitialLearningTurn,
  createLearningSessionState,
  parseLearningSessionState,
} from './LearningSessionStateService'

describe('LearningSessionStateService', () => {
  it('starts by waiting for a user explanation without assessing or revealing an answer', () => {
    const state = createLearningSessionState('解释事件循环')
    const applied = applyLearningTurn({
      state,
      userAttempt: null,
      turn: initialTurn(),
      createId: () => 'attempt-unused',
      now: 10,
    })

    expect(applied).toMatchObject({
      ok: true,
      value: {
        attempts: [],
        understandingState: 'not_assessed',
        currentPrompt: '请先用自己的话解释事件循环。',
        nextStep: 'await_attempt',
      },
    })
  })

  it('generates the first explanation request locally without answer content', () => {
    expect(createInitialLearningTurn('闭包')).toEqual({
      phase: 'waiting_user',
      feedback: { correctPoints: [], omissions: [], misconceptions: [] },
      understandingState: 'not_assessed',
      evidence: '',
      nextPrompt: {
        kind: 'question',
        content: '请先用自己的话解释你对“闭包”的当前理解，也可以指出最不确定的部分。',
        hintLevel: 0,
      },
      candidateUnderstanding: null,
    })
  })

  it('rejects an initial turn that assesses mastery or creates understanding knowledge', () => {
    expect(
      applyLearningTurn({
        state: createLearningSessionState('主题'),
        userAttempt: null,
        turn: {
          ...initialTurn(),
          understandingState: 'demonstrated',
          candidateUnderstanding: { title: '掌握', content: '已掌握', confidence: 1 },
        },
        createId: () => 'unused',
      }),
    ).toMatchObject({ ok: false, error: { code: 'validation-error' } })
  })

  it('changes understanding only by appending an evidenced user attempt', () => {
    const state = { ...createLearningSessionState('事件循环'), currentPrompt: '请解释。' }
    const applied = applyLearningTurn({
      state,
      userAttempt: '宏任务执行后会清空微任务队列。',
      turn: attemptTurn(),
      createId: () => 'attempt-1',
      now: 20,
    })

    expect(applied).toMatchObject({
      ok: true,
      value: {
        understandingState: 'partial',
        attempts: [
          {
            id: 'attempt-1',
            response: '宏任务执行后会清空微任务队列。',
            evidence: '用户指出了宏任务与微任务队列的先后关系。',
          },
        ],
      },
    })
  })

  it('requires hint levels to increase one step at a time', () => {
    const state = { ...createLearningSessionState('主题'), currentPrompt: '回答问题' }
    const skipped = applyLearningTurn({
      state,
      userAttempt: '不知道',
      turn: {
        ...attemptTurn(),
        nextPrompt: { kind: 'hint', content: '提示', hintLevel: 2 },
      },
      createId: () => 'attempt-1',
    })
    const valid = applyLearningTurn({
      state,
      userAttempt: '不知道',
      turn: {
        ...attemptTurn(),
        nextPrompt: { kind: 'hint', content: '提示', hintLevel: 1 },
      },
      createId: () => 'attempt-1',
    })

    expect(skipped).toMatchObject({ ok: false })
    expect(valid).toMatchObject({ ok: true, value: { hintLevel: 1, promptKind: 'hint' } })
  })

  it('round-trips persisted state and compiles it as the prompt source of truth', () => {
    const state = createLearningSessionState('闭包')
    expect(parseLearningSessionState(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(compileLearningStateContext(state, '我的解释')).toContain('本轮用户尝试')
    expect(compileLearningStateContext(state, '我的解释')).toContain('"我的解释"')
    expect(
      parseLearningSessionState({
        ...state,
        attempts: [{ id: 'broken', response: 42 }],
      }),
    ).toBeNull()
  })

  it('supports counterexamples, transfer questions and an evidenced needs-review terminal state', () => {
    const state = { ...createLearningSessionState('主题'), currentPrompt: '回答问题' }
    const counterexample = applyLearningTurn({
      state,
      userAttempt: '初次解释',
      turn: {
        ...attemptTurn(),
        nextPrompt: { kind: 'counterexample', content: '考虑这个反例。', hintLevel: 0 },
      },
      createId: () => 'attempt-1',
    })
    expect(counterexample).toMatchObject({
      ok: true,
      value: { promptKind: 'counterexample', nextStep: 'continue' },
    })
    if (!counterexample.ok) return
    const transfer = applyLearningTurn({
      state: counterexample.value,
      userAttempt: '修正后的解释',
      turn: {
        ...attemptTurn(),
        nextPrompt: { kind: 'transfer_question', content: '换个场景会怎样？', hintLevel: 0 },
      },
      createId: () => 'attempt-2',
    })
    expect(transfer).toMatchObject({ ok: true, value: { promptKind: 'transfer_question' } })
    if (!transfer.ok) return
    const needsReview = applyLearningTurn({
      state: transfer.value,
      userAttempt: '迁移题回答仍不稳定',
      turn: {
        ...attemptTurn(),
        phase: 'completed',
        understandingState: 'needs_review',
        evidence: '用户在迁移题中仍混淆两个阶段。',
        nextPrompt: { kind: 'none', content: '', hintLevel: 0 },
      },
      createId: () => 'attempt-3',
    })
    expect(needsReview).toMatchObject({
      ok: true,
      value: { understandingState: 'needs_review', nextStep: 'needs_review' },
    })
  })
})

function initialTurn(): LearningTurnResult {
  return {
    phase: 'waiting_user',
    feedback: { correctPoints: [], omissions: [], misconceptions: [] },
    understandingState: 'not_assessed',
    evidence: '',
    nextPrompt: {
      kind: 'question',
      content: '请先用自己的话解释事件循环。',
      hintLevel: 0,
    },
    candidateUnderstanding: null,
  }
}

function attemptTurn(): LearningTurnResult {
  return {
    phase: 'waiting_user',
    feedback: {
      correctPoints: ['指出了微任务队列'],
      omissions: ['没有说明渲染时机'],
      misconceptions: [],
    },
    understandingState: 'partial',
    evidence: '用户指出了宏任务与微任务队列的先后关系。',
    nextPrompt: {
      kind: 'guided_question',
      content: '渲染发生在哪个时点？',
      hintLevel: 0,
    },
    candidateUnderstanding: null,
  }
}
