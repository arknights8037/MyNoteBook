import { describe, expect, it } from 'vitest'

import { AgentRunEngine } from '@/services/agent/AgentRunEngine'

describe('AgentRunEngine', () => {
  it('turns commands into replayable domain events', () => {
    let time = 0
    const engine = new AgentRunEngine(() => ++time)

    engine.dispatch({ type: 'CREATE_RUN', runId: 'run-1', goal: '检查文档' })
    engine.dispatch({
      type: 'SET_PLAN',
      steps: [
        { id: 'reason', type: 'reason', status: 'pending', dependsOn: [], input: {} },
      ],
    })
    engine.dispatch({ type: 'START_STEP', stepId: 'reason' })
    engine.dispatch({ type: 'COMPLETE_STEP', stepId: 'reason' })
    engine.dispatch({ type: 'COMPLETE_RUN' })

    expect(engine.events.map((event) => event.type)).toEqual([
      'TaskCreated',
      'PlanGenerated',
      'StepStarted',
      'StepSucceeded',
      'RunCompleted',
    ])
    expect(engine.state.phase).toBe('completed')
    expect(engine.schedule()).toEqual({ type: 'STOP' })
  })
})
