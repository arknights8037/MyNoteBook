import type { AgentRunIntent } from '@/models/agent/agentSlashCommand'
import type { AgentToolCall, AgentToolRisk } from '@/models/agent/agentTool'
import type { ContextBundle } from '@/models/agent/contextBundle'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'
import type { AiProvider, AiReasoningEffort } from '@/models/ai/ai'
import type { AgentToolTag } from '@/models/cognitive/cognitive'

export type RuntimeLifecycle = 'started' | 'progress' | 'completed' | 'failed' | 'cancelled'
export type AgentRuntimeEventType =
  | `run.${RuntimeLifecycle}`
  | `model.${RuntimeLifecycle}`
  | `message.${RuntimeLifecycle}`
  | `tool.${RuntimeLifecycle}`
  | `authorization.${RuntimeLifecycle}`

export interface AgentModelPolicy {
  provider: AiProvider
  model: string
  endpoint: string
  temperature: number
  topP: number
  reasoningEffort: AiReasoningEffort
  maxOutputTokens: number
  credentialRef: { kind: 'provider_secret'; provider: AiProvider }
}

export interface AgentOutputContractDescriptor {
  id: string
  version: number
  jsonSchema: Record<string, unknown>
  systemInstruction: string
}

export interface DomainToolManifestEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  risk: AgentToolRisk
  executionAuthorization: 'not_required' | 'required'
  mutationApproval: 'not_required' | 'required'
  externalActionApproval: 'not_required' | 'required'
  maxCallsPerRun: number
  tags: AgentToolTag[]
  presentation: { label: string; category: string }
  source:
    | { kind: 'builtin' }
    | {
        kind: 'mcp'
        serverId: string
        serverName: string
        toolName: string
        readOnly: boolean
        serverTrusted: boolean
      }
}

export interface AgentRunRequestV1 {
  version: 1
  runId: string
  workItemId: string
  workflowId?: string
  sessionId: string
  objective: string
  intent: AgentRunIntent
  systemInstructions: string
  compiledContext: string
  contextBundle: ContextBundle
  executionPolicy: ExecutionPolicy
  toolManifest: DomainToolManifestEntry[]
  modelPolicy: AgentModelPolicy
  outputContract?: AgentOutputContractDescriptor
  correlationId: string
  causationId: string | null
}

export interface AgentRuntimeUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsdMicros?: number
  modelTurns?: number
}

export interface AgentRunResult {
  runId: string
  output: string
  structuredOutput?: unknown
  rounds: number
  toolCalls: AgentToolCall[]
  finishReason?: string
  usage?: AgentRuntimeUsage
}

export interface AgentRuntimeEvent<TPayload = Record<string, unknown>> {
  version: 1
  eventId: string
  runId: string
  sequence: number
  type: AgentRuntimeEventType
  occurredAt: number
  correlationId: string
  causationId: string | null
  payload: TPayload
}

export interface AgentRunSteerInput {
  kind: 'authorization_response'
  authorizationId: string
  answer: string
}

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void

export interface AgentRuntimePort {
  startRun(request: AgentRunRequestV1): Promise<AgentRunResult>
  cancelRun(runId: string): Promise<void>
  steerRun(runId: string, input: AgentRunSteerInput): Promise<void>
  subscribeEvents(runId: string, listener: AgentRuntimeEventListener): () => void
}

export class AgentRuntimeContractError extends Error {
  constructor(
    readonly code: 'duplicate_run' | 'run_not_found' | 'invalid_steer' | 'authorization_not_found',
    message: string,
  ) {
    super(message)
    this.name = 'AgentRuntimeContractError'
  }
}
