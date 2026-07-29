import type {
  AgentModelPolicy,
  AgentOutputContractDescriptor,
  AgentRunResult,
  DomainToolManifestEntry,
} from '@mynotebook/agent-runtime-contracts'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

export interface PiToolRpcInvocation {
  requestId: string
  runId: string
  turnId: string | null
  internalToolCallId: string
  providerToolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  source: DomainToolManifestEntry['source']
}

export interface PiToolRpcProgress {
  message: string
  value?: unknown
}

export interface PiToolRpcResult {
  ok: boolean
  value?: unknown
  error?: string
  errorCode?: string
  retryable?: boolean
  retryAfterMs?: number
  /** Preserves MCP's protocol-level business error bit. */
  isError?: boolean
}

export interface PiToolRpcPort {
  invoke(
    request: PiToolRpcInvocation,
    options: {
      signal?: AbortSignal
      onProgress: (progress: PiToolRpcProgress) => void
    },
  ): Promise<PiToolRpcResult>
}

export interface PiModelDriver {
  model: Model<Api>
  streamFn: StreamFn
}

export interface PiDocumentEditProposal {
  summary: string
  documents: Array<{
    documentId: string
    edits: Array<
      | {
          kind: 'replace'
          targetBlockIds: string[]
          content: string
          reason: string
        }
      | {
          kind: 'insert_before' | 'insert_after' | 'append'
          anchorBlockId: string
          content: string
          reason: string
        }
    >
  }>
}

export interface PiAgentPatchProposal {
  documentId: string
  operation: 'replace' | 'insert_before' | 'insert_after' | 'append'
  blockId: string
  targetBlockIds: string[]
  after: string
  reason: string
}

export interface PiPrototypeRunResult extends AgentRunResult {
  documentEditProposals: PiDocumentEditProposal[]
  patchProposals: PiAgentPatchProposal[]
}

export interface PiOutputValidatorRegistry {
  resolve(descriptor: AgentOutputContractDescriptor): ((value: unknown) => unknown) | null
}

export interface PiAgentRuntimeDependencies {
  toolRpc: PiToolRpcPort
  resolveModelDriver: (policy: AgentModelPolicy) => Promise<PiModelDriver> | PiModelDriver
  resolveCredential: (policy: AgentModelPolicy) => Promise<string>
  createId?: () => string
  now?: () => number
  redact?: (value: string) => string
  outputValidators?: PiOutputValidatorRegistry
  recordToolCall?: (
    call: import('@mynotebook/agent-runtime-contracts').AgentToolCall,
  ) => Promise<void>
}
