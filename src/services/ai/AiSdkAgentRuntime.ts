import type { AgentToolCall } from '@/models/agent/agentTool'
import {
  createDefaultAgentExecutionPolicy,
} from '@/services/agent/AgentToolRegistry'
import type { AgentRuntimeInput, AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import { normalizeExecutionPolicy } from '@/models/agent/executionPolicy'
import { resolveProviderCapabilities } from '@/models/agent/providerCapabilities'
import type { AgentPatchProposal, AgentWriteCommand } from '@/services/agent/AgentWriteContract'

import type { ToolLifecycleContext } from './agentRuntime/agentRuntimeToolLifecycle'
import { buildAgentToolSet } from './agentRuntime/agentRuntimeToolDefinitions'
import { runAgentStream } from './agentRuntime/agentRuntimeStream'

export {
  createCapturedProposalOutput,
  createNaturalAgentTextOutput,
  normalizeAgentOutputCandidate,
  normalizeAgentOutputForTaskIntent,
  parseAiSdkAgentOutput,
  resolveAgentOutputChannels,
} from '@/services/agent/AgentOutputNormalizer'

export async function runAiSdkAgent(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const policy = normalizeExecutionPolicy(
    input.executionPolicy ?? createDefaultAgentExecutionPolicy(input.settings.maxTokens),
  )
  if (!resolveProviderCapabilities(input.settings.provider, input.settings.model).toolChoice) {
    throw new Error('当前模型不支持 Agent 工具调用，请选择支持原生工具调用的模型。')
  }

  const calls: AgentToolCall[] = []
  const externalTools = new Map(
    (input.externalTools ?? []).map((definition) => [definition.runtimeName, definition]),
  )
  const proposedCommands: AgentWriteCommand[] = []
  const proposedPatches: AgentPatchProposal[] = []

  const ctx: ToolLifecycleContext = {
    input,
    policy,
    calls,
    callCounts: new Map(),
    externalTools,
    proposedCommands,
    proposedPatches,
    inFlightTools: new Set(),
    failedCallSignatures: new Set(),
    completedReadSignatures: new Set(),
    stepStartedAt: new Map(),
    resolvedStepDecisions: new Set(),
    activeStepNumber: 0,
    failures: 0,
  }

  const { activeToolSet, activeToolNames } = buildAgentToolSet(ctx, policy)

  return runAgentStream({ input, policy, activeToolSet, activeToolNames, ctx })
}
