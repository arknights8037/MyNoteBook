import type { AgentToolCall } from '@/models/agentTool'
import type { AiSettings } from '@/models/ai'
import type { AgentToolExecutionResult, AgentToolRequest } from './AgentToolExecutor'

export interface AgentRuntimeResult {
  output: string
  rounds: number
  toolCalls: AgentToolCall[]
}

export interface AgentProgressUpdate {
  phase: 'planning' | 'tool_running' | 'tool_completed' | 'finalizing'
  toolName?: string
  detail: string
}

export interface AgentRuntimeInput {
  taskId: string
  prompt: string
  context: string
  settings: AiSettings
  systemPrompt: string
  signal?: AbortSignal
  createId: () => string
  executeTool: (request: AgentToolRequest) => Promise<AgentToolExecutionResult>
  recordToolCall: (call: AgentToolCall) => Promise<void>
  onDelta?: (delta: string, channel?: 'content' | 'reasoning') => void
  onProgress?: (update: AgentProgressUpdate) => void
}

/** Production Agent runtime. Model/tool orchestration is owned exclusively by AI SDK. */
export async function runAgentToolLoop(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
  const { runAiSdkAgent } = await import('./AiSdkAgentRuntime')
  return runAiSdkAgent(input)
}
