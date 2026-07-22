import { invoke } from '@tauri-apps/api/core'

import { loadAppSettings } from '@/models/settings/settings'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type {
  ViewDefinition,
  ViewDependency,
  ViewGenerationConfig,
  ViewSnapshot,
  ViewType,
  ViewWritebackPolicy,
} from '@/models/knowledge/view'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import type { ViewRepository } from '@/repositories/knowledge/ViewRepository'
import { parseJsonObject, parseJsonOrNull } from '@/repositories/shared/jsonCodec'

export class TauriViewRepository implements ViewRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async createDefinition(input: {
    id: string
    name: string
    viewType: ViewType
    scopeQuery: Record<string, unknown>
    projectionSchema?: Record<string, unknown> | null
    renderSpec?: Record<string, unknown>
    writebackPolicy: ViewWritebackPolicy
    targetDocumentId?: string | null
    generation?: ViewGenerationConfig | null
    createdAt?: number
  }): Promise<AppResult<ViewDefinition>> {
    if (!input.name.trim()) {
      return err({ code: 'validation-error', message: 'View 名称不能为空。' })
    }
    if (
      input.viewType === 'generated' &&
      (!input.generation?.prompt.trim() ||
        !input.generation.provider.trim() ||
        !input.generation.model.trim())
    ) {
      return err({
        code: 'validation-error',
        message: 'Generated View 缺少 prompt、Provider 或模型。',
      })
    }
    const now = input.createdAt ?? Date.now()
    try {
      await this.sqlClient.execute(
        `INSERT INTO view_definitions (
          id, name, view_type, scope_query_json, projection_schema_json, render_spec_json,
          refresh_policy, writeback_policy, target_document_id, stale, version,
          generation_prompt, generation_provider, generation_model, generation_skill_versions_json,
          last_refreshed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, 1, 1, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          input.id,
          input.name.trim(),
          input.viewType,
          JSON.stringify(input.scopeQuery),
          input.projectionSchema ? JSON.stringify(input.projectionSchema) : null,
          JSON.stringify(input.renderSpec ?? {}),
          input.writebackPolicy,
          input.targetDocumentId ?? null,
          input.generation?.prompt ?? null,
          input.generation?.provider ?? null,
          input.generation?.model ?? null,
          JSON.stringify(input.generation?.skillVersions ?? []),
          now,
          now,
        ],
      )
      return this.getDefinition(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法创建 View Definition。'))
    }
  }

  async getDefinition(id: string): Promise<AppResult<ViewDefinition>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM view_definitions WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapDefinition(rows[0]))
        : err({ code: 'not-found', message: 'View Definition 不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取 View Definition。'))
    }
  }

  async listDefinitions(): Promise<AppResult<ViewDefinition[]>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        'SELECT * FROM view_definitions ORDER BY updated_at DESC, id ASC',
      )
      return ok(rows.map(mapDefinition))
    } catch (error) {
      return err(normalizeError(error, '无法列出 View Definition。'))
    }
  }

  async getLatestSnapshot(viewId: string): Promise<AppResult<ViewSnapshot | null>> {
    try {
      const rows = await this.sqlClient.select<Record<string, unknown>>(
        `SELECT * FROM view_snapshots WHERE view_id = ? ORDER BY created_at DESC LIMIT 1`,
        [viewId],
      )
      return ok(rows[0] ? mapSnapshot(rows[0]) : null)
    } catch (error) {
      return err(normalizeError(error, '无法读取 View Snapshot。'))
    }
  }

  async commitRefresh(input: {
    definition: ViewDefinition
    snapshot: ViewSnapshot
    dependencies: ViewDependency[]
  }): Promise<AppResult<ViewSnapshot>> {
    try {
      await invoke('commit_view_refresh', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          viewId: input.definition.id,
          expectedVersion: input.definition.version,
          snapshotId: input.snapshot.id,
          sourceSnapshotHash: input.snapshot.sourceSnapshotHash,
          renderJson: JSON.stringify(input.snapshot.render),
          dependencies: input.dependencies,
          provider: input.snapshot.provider,
          model: input.snapshot.model,
          skillVersions: input.snapshot.skillVersions,
          generatedAt: input.snapshot.generatedAt,
          correlationId: input.snapshot.correlationId,
          causationId: input.snapshot.causationId,
          eventId: `${input.snapshot.id}-event`,
          outboxId: `${input.snapshot.id}-outbox`,
          createdAt: input.snapshot.createdAt,
        },
      })
      return ok(input.snapshot)
    } catch (error) {
      return err(normalizeError(error, '无法提交 View 刷新结果。'))
    }
  }

  async setManualOverride(input: {
    viewId: string
    expectedVersion: number
    content: unknown
    correlationId: string
    updatedAt: number
  }): Promise<AppResult<ViewDefinition>> {
    try {
      await invoke('set_view_manual_override', {
        input: {
          dataDirectory: loadAppSettings().dataDirectory,
          ...input,
          contentJson: JSON.stringify(input.content),
          eventId: `${input.viewId}-override-${input.updatedAt}`,
          outboxId: `${input.viewId}-override-outbox-${input.updatedAt}`,
        },
      })
      return this.getDefinition(input.viewId)
    } catch (error) {
      return err(normalizeError(error, '无法保存 View 手动覆盖。'))
    }
  }
}

function mapDefinition(row: Record<string, unknown>): ViewDefinition {
  return {
    id: String(row.id),
    name: String(row.name),
    viewType: String(row.view_type) as ViewType,
    scopeQuery: parseJsonObject(row.scope_query_json),
    projectionSchema: row.projection_schema_json
      ? parseJsonObject(row.projection_schema_json)
      : null,
    renderSpec: parseJsonObject(row.render_spec_json),
    refreshPolicy: 'manual',
    writebackPolicy: String(row.writeback_policy) as ViewWritebackPolicy,
    targetDocumentId: typeof row.target_document_id === 'string' ? row.target_document_id : null,
    generation:
      typeof row.generation_prompt === 'string' &&
      typeof row.generation_provider === 'string' &&
      typeof row.generation_model === 'string'
        ? {
            prompt: row.generation_prompt,
            provider: row.generation_provider,
            model: row.generation_model,
            skillVersions: parseSkillVersions(row.generation_skill_versions_json),
          }
        : null,
    manualOverride: Boolean(row.manual_override),
    overrideContent: parseJsonOrNull(row.override_content_json),
    overrideUpdatedAt: typeof row.override_updated_at === 'number' ? row.override_updated_at : null,
    stale: Boolean(row.stale),
    version: Number(row.version),
    currentSnapshotId: typeof row.current_snapshot_id === 'string' ? row.current_snapshot_id : null,
    lastRefreshedAt: typeof row.last_refreshed_at === 'number' ? row.last_refreshed_at : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapSnapshot(row: Record<string, unknown>): ViewSnapshot {
  return {
    id: String(row.id),
    viewId: String(row.view_id),
    status: String(row.status) as ViewSnapshot['status'],
    sourceSnapshotHash: String(row.source_snapshot_hash),
    render: parseJsonOrNull(row.render_json),
    provider: typeof row.provider === 'string' ? row.provider : null,
    model: typeof row.model === 'string' ? row.model : null,
    skillVersions: parseSkillVersions(row.skill_versions_json),
    generatedAt: typeof row.generated_at === 'number' ? row.generated_at : null,
    protectedByOverride: Boolean(row.protected_by_override),
    correlationId: typeof row.correlation_id === 'string' ? row.correlation_id : null,
    causationId: typeof row.causation_id === 'string' ? row.causation_id : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: Number(row.created_at),
  }
}

function parseSkillVersions(value: unknown): Array<{ id: string; version: string | null }> {
  const parsed = parseJsonOrNull(value)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string')
      return []
    const version = (item as { version?: unknown }).version
    return [
      { id: (item as { id: string }).id, version: typeof version === 'string' ? version : null },
    ]
  })
}
