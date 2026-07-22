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
})
