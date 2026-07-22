import { invoke } from '@tauri-apps/api/core'

import type {
  Delegation,
  DelegateType,
  DelegationOperation,
  ExternalSubmission,
  OutboxMessage,
} from '@/models/knowledge/governance'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import { loadAppSettings } from '@/models/settings/settings'
import type { GovernanceRepository } from '@/repositories/knowledge/GovernanceRepository'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import type { ContextBundle, ContextBundleSource } from '@/models/agent/contextBundle'
import { parseJsonArray, parseJsonObject, parseStringArray } from '@/repositories/shared/jsonCodec'

export class TauriGovernanceRepository implements GovernanceRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async createDelegation(input: {
    id: string
    taskRunId: string
    delegateType: DelegateType
    externalActorId: string
    contextBundleId?: string | null
    capabilityTokenHash: string
    allowedOperations: DelegationOperation[]
    expiresAt: number
    correlationId: string
    causationId?: string | null
    createdAt: number
  }): Promise<AppResult<Delegation>> {
    try {
      await invoke('create_delegation', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          ...input,
          contextBundleId: input.contextBundleId ?? null,
          causationId: input.causationId ?? null,
          eventId: `${input.id}-created-event`,
          outboxId: `${input.id}-created-outbox`,
        },
      })
      return this.getDelegation(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法创建外部委派。'))
    }
  }

  async getDelegation(id: string): Promise<AppResult<Delegation>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM delegations WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapDelegation(rows[0]))
        : err({ code: 'not-found', message: 'Delegation 不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取 Delegation。'))
    }
  }

  async getContextBundle(id: string): Promise<AppResult<ContextBundle>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM context_bundles WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapContextBundle(rows[0]))
        : err({ code: 'not-found', message: 'Context Bundle 不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取 Context Bundle。'))
    }
  }

  async submitExternal(input: {
    delegationId: string
    capabilityTokenHash: string
    idempotencyKey: string
    requestHash: string
    submission: ExternalSubmission
    submittedAt: number
  }): Promise<AppResult<{ entityId: string; replayed: boolean }>> {
    try {
      return ok(
        await invoke('submit_external_work', {
          input: {
            dataDirectory: loadAppSettings().dataDirectory,
            ...input,
            submissionJson: JSON.stringify(input.submission),
            eventId: `${input.delegationId}-${input.idempotencyKey}-event`,
            outboxId: `${input.delegationId}-${input.idempotencyKey}-outbox`,
          },
        }),
      )
    } catch (error) {
      return err(normalizeError(error, '外部结果提交失败。'))
    }
  }

  async claimOutbox(input: {
    workerId: string
    now: number
    leaseMs: number
    limit: number
  }): Promise<AppResult<OutboxMessage[]>> {
    try {
      return ok(
        await invoke('claim_outbox_messages', {
          input: { dataDirectory: loadAppSettings().dataDirectory, ...input },
        }),
      )
    } catch (error) {
      return err(normalizeError(error, '无法领取 Outbox 消息。'))
    }
  }

  async settleOutbox(input: {
    id: string
    workerId: string
    published: boolean
    error?: string | null
    now: number
    retryAt?: number | null
  }): Promise<AppResult<void>> {
    try {
      await invoke('settle_outbox_message', {
        input: { dataDirectory: loadAppSettings().dataDirectory, ...input },
      })
      return ok(undefined)
    } catch (error) {
      return err(normalizeError(error, '无法更新 Outbox 消息。'))
    }
  }
}

function mapDelegation(row: Record<string, unknown>): Delegation {
  return {
    id: String(row.id),
    taskRunId: String(row.task_run_id),
    delegateType: String(row.delegate_type) as Delegation['delegateType'],
    externalActorId: String(row.external_actor_id),
    status: String(row.status) as Delegation['status'],
    contextBundleId: typeof row.context_bundle_id === 'string' ? row.context_bundle_id : null,
    allowedOperations: parseStringArray(row.allowed_operations_json) as DelegationOperation[],
    expiresAt: Number(row.expires_at),
    correlationId: String(row.correlation_id),
    causationId: typeof row.causation_id === 'string' ? row.causation_id : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapContextBundle(row: Record<string, unknown>): ContextBundle {
  const version = Number(row.version) === 2 ? 2 : 1
  const sources = parseJsonArray(row.sources_json).map((source) => {
    const item = source as Partial<ContextBundleSource>
    return {
      kind: 'document_block' as const,
      documentId: String(item.documentId ?? ''),
      blockId: typeof item.blockId === 'string' ? item.blockId : null,
      revision: Number(item.revision ?? 0),
      title: String(item.title ?? ''),
      contentHash: String(item.contentHash ?? ''),
      contentSnapshot: typeof item.contentSnapshot === 'string' ? item.contentSnapshot : null,
    }
  })
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    version,
    scope: parseJsonObject(row.scope_json),
    permissionSnapshot: parseJsonObject(
      row.permission_snapshot_json,
    ) as ContextBundle['permissionSnapshot'],
    sources,
    activeRules: parseJsonArray(row.active_rules_json) as Array<Record<string, unknown>>,
    decisions: parseJsonArray(row.decisions_json) as Array<Record<string, unknown>>,
    conflicts: parseJsonArray(row.conflicts_json) as Array<Record<string, unknown>>,
    compiler: parseJsonObject(row.compiler_json) as unknown as ContextBundle['compiler'],
    snapshotHash: String(row.snapshot_hash),
    correlationId: String(row.correlation_id),
    causationId: typeof row.causation_id === 'string' ? row.causation_id : null,
    createdAt: Number(row.created_at),
  }
}
