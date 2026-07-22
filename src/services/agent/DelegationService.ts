import { createSnapshotHash } from '@/models/agent/contextBundle'
import type {
  DelegateType,
  DelegatedCompletion,
  DelegationOperation,
  ExternalSubmission,
} from '@/models/knowledge/governance'
import type { GovernanceRepository } from '@/repositories/knowledge/GovernanceRepository'

export class DelegationService {
  constructor(
    private readonly governance: GovernanceRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: {
    taskRunId: string
    delegateType: DelegateType
    externalActorId: string
    contextBundleId?: string | null
    allowedOperations: DelegationOperation[]
    ttlMs?: number
    correlationId?: string
  }) {
    const createdAt = this.now()
    const capabilityToken = createCapabilityToken()
    const capabilityTokenHash = await createSnapshotHash(capabilityToken)
    const id = this.createId('delegation')
    const result = await this.governance.createDelegation({
      id,
      taskRunId: input.taskRunId,
      delegateType: input.delegateType,
      externalActorId: input.externalActorId,
      contextBundleId: input.contextBundleId ?? null,
      capabilityTokenHash,
      allowedOperations: Array.from(new Set(input.allowedOperations)),
      expiresAt: createdAt + Math.max(60_000, input.ttlMs ?? 24 * 60 * 60 * 1000),
      correlationId: input.correlationId ?? id,
      causationId: null,
      createdAt,
    })
    return result.ok
      ? { ok: true as const, value: { delegation: result.value, capabilityToken } }
      : result
  }

  async submit(
    delegationId: string,
    capabilityToken: string,
    idempotencyKey: string,
    submission: ExternalSubmission,
  ) {
    const capabilityTokenHash = await createSnapshotHash(capabilityToken)
    const requestHash = await createSnapshotHash({ delegationId, submission })
    return this.governance.submitExternal({
      delegationId,
      capabilityTokenHash,
      idempotencyKey,
      requestHash,
      submission,
      submittedAt: this.now(),
    })
  }

  getContextBundle(id: string) {
    return this.governance.getContextBundle(id)
  }

  async submitCompletion(
    delegationId: string,
    capabilityToken: string,
    idempotencyKey: string,
    completion: DelegatedCompletion,
  ) {
    const ordered: ExternalSubmission[] = [
      ...(completion.artifacts ?? []),
      ...(completion.evidence ?? []),
      ...(completion.changeSet ? [completion.changeSet] : []),
      completion.result,
    ]
    let lastResult: Awaited<ReturnType<DelegationService['submit']>> | null = null
    for (let index = 0; index < ordered.length; index += 1) {
      const submission = ordered[index]!
      lastResult = await this.submit(
        delegationId,
        capabilityToken,
        `${idempotencyKey}:${index}:${submission.type}`,
        submission,
      )
      if (!lastResult.ok) return lastResult
    }
    return lastResult!
  }
}

function createCapabilityToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}
