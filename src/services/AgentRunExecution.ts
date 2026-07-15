import type { AgentRunIntent } from '@/models/agentSlashCommand'
import type { AgentExternalTool } from '@/models/mcp'
import type { ExecutionPolicy } from '@/models/executionPolicy'
import type { AgentOutputContract } from './AgentOutputContract'

export interface AgentRunExecutionPlan {
  prompt: string
  context: string
  systemPrompt: string
  intent: AgentRunIntent
  executionPolicy: ExecutionPolicy
  externalTools: AgentExternalTool[]
  outputContract?: AgentOutputContract<unknown>
}

/**
 * Freezes the policy-bearing Runtime input at the UI/Agent boundary.
 * Cognitive contracts are structured-result contracts and cannot share a write-enabled run.
 */
export function prepareAgentRunExecution(input: {
  prompt: string
  context: string
  systemPrompt: string
  intent: AgentRunIntent
  executionPolicy: ExecutionPolicy
  externalTools?: readonly AgentExternalTool[]
  outputContract?: AgentOutputContract<unknown>
}): AgentRunExecutionPlan {
  if (input.outputContract && input.executionPolicy.allowWriteProposals) {
    throw new Error('结构化认知 Output Contract 不能进入写入提案运行。')
  }
  return {
    prompt: input.prompt,
    context: input.context,
    systemPrompt: input.systemPrompt,
    intent: input.intent,
    executionPolicy: {
      ...input.executionPolicy,
      allowedTools: [...input.executionPolicy.allowedTools],
    },
    externalTools: [...(input.externalTools ?? [])],
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
  }
}
