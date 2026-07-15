import type { AgentToolCall } from '@/models/agentTool'
import type { AiSettings } from '@/models/ai'
import type { AgentAuthorizationRequest } from '@/models/agentRuntime'
import type { AgentRunIntent } from '@/models/agentSlashCommand'
import type { AgentExternalTool } from '@/models/mcp'
import type { ExecutionPolicy } from '@/models/executionPolicy'
import type { AgentToolExecutionResult, AgentToolRequest } from './AgentToolExecutor'
import { safeErrorMessage } from './SensitiveDataRedaction'
import type { AgentOutputContract } from './AgentOutputContract'
import type { AgentDocumentEditProposal } from './AgentEditProposalGuard'

export interface AgentRuntimeResult {
  output: string
  rounds: number
  toolCalls: AgentToolCall[]
  finishReason?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
}

export interface AgentProgressUpdate {
  phase: 'planning' | 'tool_running' | 'tool_completed' | 'finalizing'
  toolName?: string
  detail: string
  toolCall?: AgentToolCall
}

export interface AgentRuntimeInput {
  taskId: string
  prompt: string
  context: string
  settings: AiSettings
  systemPrompt: string
  intent?: AgentRunIntent
  signal?: AbortSignal
  createId: () => string
  executeTool: (request: AgentToolRequest) => Promise<AgentToolExecutionResult>
  recordToolCall: (call: AgentToolCall) => Promise<void>
  requestAuthorizerInput?: (request: Omit<AgentAuthorizationRequest, 'id'>) => Promise<string>
  externalTools?: AgentExternalTool[]
  executionPolicy?: ExecutionPolicy
  outputContract?: AgentOutputContract<unknown>
  validateDocumentEditProposal?: (proposal: AgentDocumentEditProposal) => void
  onDelta?: (delta: string, channel?: 'content' | 'reasoning') => void
  onProgress?: (update: AgentProgressUpdate) => void
}

/** Production Agent runtime. Model/tool orchestration is owned exclusively by AI SDK. */
export async function runAgentToolLoop(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const { runAiSdkAgent } = await import('./AiSdkAgentRuntime')
  try {
    return await runAiSdkAgent(input)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    const sanitized = new Error(safeErrorMessage(error))
    sanitized.name = error instanceof Error ? error.name : 'Error'
    throw sanitized
  }
}
