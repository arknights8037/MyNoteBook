import { describe, expect, it } from 'vitest'

import { createDefaultExecutionPolicy } from '@/models/agent/executionPolicy'
import { COGNITIVE_TEST_OUTPUT_CONTRACT } from '@/services/cognitive/CognitiveRegistry'
import { prepareAgentRunExecution } from '@/services/agent/AgentRunExecution'

describe('prepareAgentRunExecution', () => {
  it('freezes the legacy command/Patch write run without injecting a cognitive contract', () => {
    const policy = createDefaultExecutionPolicy({
      tokenBudget: 2048,
      allowedTools: ['get_current_document', 'replace_block'],
    })
    const plan = prepareAgentRunExecution({
      prompt: '修改隔离测试块',
      context: 'block=smoke',
      systemPrompt: '只能提交待确认修改。',
      intent: 'default',
      executionPolicy: policy,
    })

    policy.allowedTools.push('create_group')
    expect(plan.executionPolicy.allowedTools).toEqual(['get_current_document', 'replace_block'])
    expect(plan.executionPolicy.allowWriteProposals).toBe(true)
    expect(plan.outputContract).toBeUndefined()
  })

  it('rejects combining a cognitive result contract with write permission', () => {
    expect(() =>
      prepareAgentRunExecution({
        prompt: '认知结果',
        context: '',
        systemPrompt: '',
        intent: 'review',
        executionPolicy: createDefaultExecutionPolicy({
          tokenBudget: 2048,
          allowedTools: ['replace_block'],
        }),
        outputContract: COGNITIVE_TEST_OUTPUT_CONTRACT,
      }),
    ).toThrow('不能进入写入提案运行')
  })

  it('allows a read-only cognitive execution plan', () => {
    const policy = {
      ...createDefaultExecutionPolicy({
        tokenBudget: 2048,
        allowedTools: ['get_current_document'],
        riskLevel: 'read_only',
      }),
      allowWriteProposals: false,
    }
    const plan = prepareAgentRunExecution({
      prompt: '审阅',
      context: '',
      systemPrompt: '',
      intent: 'review',
      executionPolicy: policy,
      outputContract: COGNITIVE_TEST_OUTPUT_CONTRACT,
    })
    expect(plan.outputContract?.id).toBe('cognitive-test')
  })
})
