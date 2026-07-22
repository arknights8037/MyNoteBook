import type { AiProvider } from '@/models/ai/ai'
import type { ExecutionPolicy } from '@/models/agent/executionPolicy'

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
  permissionSnapshot: { actor: 'local_user'; canReadKnowledge: true; canProposeWrites: boolean }
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

export async function compileContextBundle(input: {
  id: string
  taskId: string
  correlationId: string
  causationId?: string | null
  query: string
  documentId: string
  contextScope: string
  currentRevision: number
  provider: AiProvider
  model: string
  executionPolicy: ExecutionPolicy
  sources: Array<{
    documentId: string
    blockId?: string
    documentTitle: string
    revision: number
    contentSnippet: string
  }>
  activeRules?: Array<Record<string, unknown>>
  decisions?: Array<Record<string, unknown>>
  createdAt?: number
}): Promise<ContextBundle> {
  const sources = await Promise.all(
    input.sources.map(async (source) => ({
      kind: 'document_block' as const,
      documentId: source.documentId,
      blockId: source.blockId ?? null,
      revision: source.revision,
      title: source.documentTitle,
      contentHash: await sha256(source.contentSnippet),
      contentSnapshot: source.contentSnippet,
    })),
  )
  const material = {
    version: 2,
    taskId: input.taskId,
    scope: {
      documentId: input.documentId,
      contextScope: input.contextScope,
      currentRevision: input.currentRevision,
    },
    permissionSnapshot: {
      actor: 'local_user' as const,
      canReadKnowledge: true as const,
      canProposeWrites: input.executionPolicy.allowWriteProposals,
    },
    sources,
    activeRules: input.activeRules ?? [],
    decisions: input.decisions ?? [],
    conflicts: [],
    compiler: {
      strategy: 'fts5-current-document-v1' as const,
      version: 1 as const,
      query: input.query,
      tokenBudget: input.executionPolicy.tokenBudget,
      targetProvider: input.provider,
      targetModel: input.model,
      executionPolicy: input.executionPolicy,
    },
  }
  return {
    id: input.id,
    ...material,
    snapshotHash: await createSnapshotHash(material),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    createdAt: input.createdAt ?? Date.now(),
  }
}

export function createSnapshotHash(value: unknown): Promise<string> {
  return sha256(stableStringify(value))
}

export function createContentHash(value: string): Promise<string> {
  return sha256(value)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
