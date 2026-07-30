import { describe, expect, it } from 'vitest'

import type { AgentTask } from '@/models/agent/agent'
import { createAgentRunRuntimeController } from '@/composables/agentRun/agentRunRuntimeController'

describe('agentRunRuntimeController', () => {
  it('owns the complete authorizer request lifecycle', async () => {
    const controller = createAgentRunRuntimeController(() => 'authorization-1')
    const task = { currentStep: '' } as AgentTask
    const answer = controller.waitForAuthorizerInput(
      {
        question: '继续吗？',
        context: '需要确认',
        options: ['继续', '停止'],
        allowFreeText: false,
      },
      task,
    )

    expect(task.currentStep).toBe('等待授权人回答')
    expect(controller.runtimeState.value.status).toBe('waiting_authorizer')
    expect(controller.answerAuthorization('authorization-1', '未知')).toBe(false)
    expect(controller.answerAuthorization('authorization-1', '继续')).toBe(true)
    await expect(answer).resolves.toBe('继续')
    expect(controller.runtimeState.value.authorizationRequest).toBeNull()
    expect(controller.runEvents.value.map((event) => event.type)).toContain('ApprovalGranted')
  })

  it('rebuilds an active waiting view from the Rust supervisor snapshot', () => {
    const controller = createAgentRunRuntimeController(() => 'generated')
    controller.restoreActive({
      runId: 'run-1',
      goal: '后台审阅',
      detail: '等待授权人回答',
      authorizationRequest: {
        id: 'authorization-1',
        question: '继续吗？',
        context: '恢复的授权请求',
        options: ['继续', '停止'],
        allowFreeText: false,
      },
    })

    expect(controller.runtimeState.value).toMatchObject({
      status: 'waiting_authorizer',
      phase: 'waiting_authorizer',
      authorizationRequest: { id: 'authorization-1' },
    })
    expect(controller.settleRestoredAuthorization('authorization-1')).toBe(true)
    expect(controller.runtimeState.value).toMatchObject({
      status: 'running',
      phase: 'tool_running',
      authorizationRequest: null,
    })
  })
})
