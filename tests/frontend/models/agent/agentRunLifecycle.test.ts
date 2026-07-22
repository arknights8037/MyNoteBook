import { describe, expect, it } from 'vitest'

import {
  createIdleAgentRunLifecycle,
  reduceAgentRunEvent,
  scheduleAgentRun,
  type AgentPlanStep,
  type AgentRunEvent,
} from '@/models/agent/agentRunLifecycle'

const steps: AgentPlanStep[] = [
  { id: 'reason', type: 'reason', status: 'pending', dependsOn: [], input: {} },
  {
    id: 'tool',
    type: 'tool',
    status: 'pending',
    dependsOn: ['reason'],
    input: { capability: 'knowledge.search' },
  },
]

describe('agentRunLifecycle', () => {
  it('reduces task, plan and approval events without creating compound states', () => {
    const events: AgentRunEvent[] = [
      { type: 'TaskCreated', runId: 'run-1', goal: '整理资料', occurredAt: 1 },
      { type: 'PlanGenerated', steps, occurredAt: 2 },
      { type: 'StepStarted', stepId: 'reason', occurredAt: 3 },
      { type: 'StepSucceeded', stepId: 'reason', occurredAt: 4 },
      { type: 'StepStarted', stepId: 'tool', occurredAt: 5 },
      {
        type: 'ApprovalRequested',
        approvalId: 'approval-1',
        stepId: 'tool',
        question: '允许调用外部工具吗？',
        occurredAt: 6,
      },
    ]
    const state = events.reduce(reduceAgentRunEvent, createIdleAgentRunLifecycle())

    expect(state.phase).toBe('waiting_user')
    expect(state.currentStepId).toBe('tool')
    expect(state.pendingApproval).toMatchObject({ id: 'approval-1', stepId: 'tool' })
    expect(scheduleAgentRun(state)).toEqual({ type: 'WAIT', reason: 'user' })
  })

  it('lets the scheduler derive the next runnable step from dependencies', () => {
    let state = reduceAgentRunEvent(createIdleAgentRunLifecycle(), {
      type: 'TaskCreated',
      runId: 'run-1',
      goal: '整理资料',
      occurredAt: 1,
    })
    state = reduceAgentRunEvent(state, { type: 'PlanGenerated', steps, occurredAt: 2 })
    expect(scheduleAgentRun(state)).toEqual({ type: 'EXECUTE_STEP', stepId: 'reason' })

    state = reduceAgentRunEvent(state, { type: 'StepStarted', stepId: 'reason', occurredAt: 3 })
    state = reduceAgentRunEvent(state, {
      type: 'StepSucceeded',
      stepId: 'reason',
      occurredAt: 4,
    })
    expect(scheduleAgentRun(state)).toEqual({ type: 'EXECUTE_STEP', stepId: 'tool' })
  })

  it('keeps tool-call failure separate from the run terminal lifecycle', () => {
    let state = reduceAgentRunEvent(createIdleAgentRunLifecycle(), {
      type: 'TaskCreated',
      runId: 'run-1',
      goal: '整理资料',
      occurredAt: 1,
    })
    state = reduceAgentRunEvent(state, {
      type: 'ToolCallRequested',
      stepId: null,
      toolCallId: 'tool-1',
      occurredAt: 2,
    })
    state = reduceAgentRunEvent(state, {
      type: 'ToolCallFailed',
      toolCallId: 'tool-1',
      error: 'timeout',
      occurredAt: 3,
    })

    expect(state.phase).toBe('executing')
    expect(state.activeToolCallId).toBeNull()
    expect(state.error).toBe('timeout')
  })
})
