export type AgentRunIntent =
  | 'default'
  | 'plan'
  | 'create'
  | 'research'
  | 'review'
  | 'learning'
  | 'interactive'
  | 'signal'

export type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'openai-compatible'
export type AiReasoningEffort = 'auto' | 'low' | 'medium' | 'high'
export type AgentToolRisk = 'read' | 'draft' | 'write'
export type AgentToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rejected'
export type AgentToolTag =
  | 'document.read'
  | 'document.propose_write'
  | 'knowledge.read'
  | 'knowledge.propose_write'
  | 'knowledge.validate'
  | 'system.inspect'
  | 'external.read'
  | 'external.may_write'
  | 'cognition.interact'

export interface ExecutionBudget {
  maxInputTokens: number | null
  maxOutputTokens: number
  maxTotalTokens: number | null
  maxCostUsdMicros: number | null
  maxModelTurns: number
  maxParallelTools: number | null
}

export interface ExecutionPolicy {
  version: 1
  maxToolRounds: number
  maxDurationMs: number
  maxToolFailures: number
  tokenBudget: number
  allowedTools: string[]
  riskLevel: 'read_only' | 'propose_write' | 'sensitive'
  allowUserInput: boolean
  allowWriteProposals: boolean
  maxRetries: number
  budget?: ExecutionBudget
}

export interface ContextBundleSource {
  kind: 'document_block'
  documentId: string
  blockId: string | null
  revision: number
  title: string
  contentHash: string
  contentSnapshot: string | null
}

export interface ContextBundle {
  id: string
  taskId: string
  version: 1 | 2
  scope: Record<string, unknown>
  permissionSnapshot: {
    actor: 'local_user'
    canReadKnowledge: true
    canProposeWrites: boolean
  }
  sources: ContextBundleSource[]
  activeRules: Array<Record<string, unknown>>
  decisions: Array<Record<string, unknown>>
  conflicts: Array<Record<string, unknown>>
  compiler: {
    strategy: 'fts5-current-document-v1'
    version: 1
    query: string
    tokenBudget: number
    targetProvider: AiProvider
    targetModel: string
    executionPolicy: ExecutionPolicy
  }
  snapshotHash: string
  correlationId: string
  causationId: string | null
  createdAt: number
}

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
  presentation: {
    label: string
    category: 'document' | 'knowledge' | 'system' | 'interaction' | 'external'
  }
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

export interface DomainEventEnvelopeV1 {
  version: 1
  eventId: string
  eventType: string
  source: string
  occurredAt: number
  actorId: string
  workspaceId: string | null
  correlationId: string
  causationId: string | null
  deduplicationKey: string
  payload: unknown
  securityScope: Record<string, unknown>
}

export type ExternalActionStatus =
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'dead_lettered'
  | 'rejected'
  | 'cancelled'

/**
 * Contract scaffold for Phase 5. Defining this envelope does not enable an
 * external side effect; Rust Action Gateway ownership and approval are still required.
 */
export interface ExternalActionRequestV1 {
  version: 1
  actionId: string
  workflowId: string
  workItemId: string
  runId: string | null
  actionType: string
  target: Record<string, unknown>
  input: Record<string, unknown>
  idempotencyKey: string
  fencingToken: string
  approvalId: string
  status: ExternalActionStatus
  correlationId: string
  causationId: string | null
  createdAt: number
}

export interface ExternalActionResultV1 {
  version: 1
  actionId: string
  idempotencyKey: string
  fencingToken: string
  outcome: 'completed' | 'failed' | 'dead_lettered'
  providerReference: string | null
  output: unknown
  error: string | null
  completedAt: number
}

/**
 * UI-to-sidecar launch input. It deliberately contains user-visible state and
 * model configuration only; the sidecar derives the task, Context Bundle,
 * policy snapshot and Runtime request without receiving credentials.
 */
export interface AgentSidecarSubmissionV1 {
  version: 1
  runId: string
  workItemId: string
  workflowId?: string
  sessionId: string
  document: {
    id: string
    title: string
    tags: string[]
    sourceUrl: string
    author: string
    text: string
    markdown: string
    revision: number | null
    blocks: Array<{
      id: string
      type: string
      text: string
      markdown?: string
      index: number
    }>
    selectedBlockIds: string[]
    documents: Array<{
      id: string
      title: string
      documentKind: 'article' | 'group'
      isDeleted: boolean
      parentId?: string | null
    }>
  }
  workspace: {
    projectId: string
    projectName: string
    rootDocumentIds: string[]
    conversationId: string
  }
  objective: string
  conversationContext?: string
  intent: AgentRunIntent
  systemInstructions: string
  skillInstructions?: string
  modelPolicy: AgentModelPolicy
  configuredMaxTokens: number
  externalTools: Array<{
    serverId: string
    serverName: string
    name: string
    runtimeName: string
    description: string
    inputSchema: Record<string, unknown>
    readOnly: boolean
    serverTrusted: boolean
    executionAuthorization: 'not_required' | 'required'
    mutationApproval: 'not_required' | 'required'
    externalActionApproval: 'not_required' | 'required'
    maxCallsPerRun: number
    tags: AgentToolTag[]
    presentation: DomainToolManifestEntry['presentation']
  }>
  explicitTargets: Array<{
    id: string
    kind: 'document' | 'knowledge_asset'
    title: string
    revision?: number | null
    content?: string
  }>
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

export interface AgentToolCall {
  id: string
  taskId: string
  runId: string
  turnId: string | null
  providerToolCallId: string | null
  toolName: string
  argumentsJson: string
  resultJson: string | null
  status: AgentToolCallStatus
  startedAt: number
  completedAt: number | null
  error: string | null
}

export interface AgentRunResult {
  runId: string
  output: string
  structuredOutput?: unknown
  rounds: number
  toolCalls: AgentToolCall[]
  finishReason?: string
  usage?: AgentRuntimeUsage
  /** Sidecar-owned terminal projection. It contains proposals only, never applied changes. */
  sidecarFinalization?: AgentSidecarFinalizationV1
}

export interface AgentSidecarPatchDraft {
  patchId: string
  taskId: string
  operation:
    | 'replace'
    | 'insert_before'
    | 'insert_after'
    | 'append'
    | 'create_document'
    | 'create_group'
  documentId: string
  blockId: string
  targetBlockIds: string[]
  expectedVersion: number
  before: string
  after: string
  reason: string
  documentTitle?: string
  parentDocumentId?: string | null
}

/** Serializable result of the sidecar's terminal proposal compiler. */
export interface AgentSidecarFinalizationV1 {
  version: 1
  taskId: string
  runId: string
  outcome: 'proposal' | 'no_change' | 'blocked'
  summary: string
  taskStatus: 'waiting_confirmation' | 'completed'
  currentStep: string
  completedAt: number | null
  patches: AgentSidecarPatchDraft[]
  sources: Array<{ documentId: string; documentTitle: string; blockIds: string[] }>
  report: {
    version: 1
    outcome: 'proposal' | 'no_change' | 'blocked'
    summary: string
    patchCount: number
    targetDocumentIds: string[]
    finishReason?: string
    usage?: AgentRuntimeUsage
  }
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

export const AGENT_WORKER_PROTOCOL_VERSION = 1 as const

export interface AgentWorkerIdentity {
  protocolVersion: typeof AGENT_WORKER_PROTOCOL_VERSION
  workerInstanceId: string
  pid: number
  runtime: 'ai-sdk'
  runtimeVersion: string
}

export interface AgentWorkerToolInvocation {
  requestId: string
  runId: string
  turnId: string | null
  internalToolCallId: string
  providerToolCallId: string | null
  toolName: string
  arguments: Record<string, unknown>
  source: DomainToolManifestEntry['source']
}

export interface AgentWorkerToolResult {
  ok: boolean
  value?: unknown
  error?: string
  errorCode?: string
  retryable?: boolean
  retryAfterMs?: number
  isError?: boolean
}

export interface AgentWorkerAuthorizationRequest {
  authorizationId: string
  runId: string
  question: string
  context: string
  options: string[]
  allowFreeText: boolean
}

export interface AgentWorkerProviderRequest {
  requestId: string
  runId: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface AgentWorkerError {
  code:
    | AgentRuntimeContractError['code']
    | 'worker_protocol_error'
    | 'worker_unavailable'
    | 'runtime_error'
  message: string
  retryable: boolean
}

export type AgentWorkerHostMessage =
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'runtime.hello'
      supervisorInstanceId: string
      protocolVersion: typeof AGENT_WORKER_PROTOCOL_VERSION
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.start'
      requestId: string
      request: AgentRunRequestV1
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'orchestration.start'
      requestId: string
      submission: AgentSidecarSubmissionV1
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.cancel'
      requestId: string
      runId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.steer'
      requestId: string
      runId: string
      input: AgentRunSteerInput
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'tool.result'
      requestId: string
      result: AgentWorkerToolResult
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'authorization.result'
      requestId: string
      authorizationId: string
      answer: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'tool.recorded'
      requestId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'provider.response.started'
      requestId: string
      status: number
      headers: Record<string, string>
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'provider.response.chunk'
      requestId: string
      bodyBase64: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'provider.response.completed'
      requestId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'provider.response.failed'
      requestId: string
      error: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'shutdown'
      reason: string
    }

export type AgentWorkerMessage =
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'runtime.hello'
      identity: AgentWorkerIdentity
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.event'
      event: AgentRuntimeEvent
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'orchestration.prepared'
      requestId: string
      task: {
        id: string
        runId: string
        workflowId: string | null
        sessionId: string
        documentId: string
        projectId: string
        conversationId: string
        status: string
        userInstruction: string
        contextScope: string
        model: string
        currentStep: string
        createdAt: number
        correlationId: string
        causationId: string | null
        executionPolicy: ExecutionPolicy
        contextBundleId: string | null
        provider: AiProvider
      }
      request: AgentRunRequestV1
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'orchestration.completed'
      requestId: string
      finalization: AgentSidecarFinalizationV1
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.result'
      requestId: string
      result: AgentRunResult
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.error'
      requestId: string
      runId: string
      error: AgentWorkerError
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.cancelled'
      requestId: string
      runId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'run.steered'
      requestId: string
      runId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'tool.invoke'
      request: AgentWorkerToolInvocation
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'tool.cancel'
      internalToolCallId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'tool.record'
      requestId: string
      call: AgentToolCall
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'authorization.request'
      requestId: string
      request: AgentWorkerAuthorizationRequest
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'provider.request'
      request: AgentWorkerProviderRequest
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'provider.cancel'
      requestId: string
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'heartbeat'
      workerInstanceId: string
      activeRunIds: string[]
      occurredAt: number
    }
  | {
      version: typeof AGENT_WORKER_PROTOCOL_VERSION
      type: 'shutdown'
      workerInstanceId: string
      reason: string
    }
