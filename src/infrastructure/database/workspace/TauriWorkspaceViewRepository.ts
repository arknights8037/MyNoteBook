import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import {
  validateWorkspaceViewPayload,
  type StructuredWorkspaceView,
  type StructuredWorkspaceViewPayload,
  type StructuredWorkspaceViewSummary,
  type StructuredWorkspaceViewType,
} from '@/models/workspace/workspaceView'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import type { WorkspaceViewRepository } from '@/repositories/workspace/WorkspaceViewRepository'
import { JsonCodecError, parseJsonStrict } from '@/repositories/shared/jsonCodec'

interface Row extends Record<string, unknown> {
  id: string
  parent_id: string | null
  sort_order: number
  view_type: StructuredWorkspaceViewType
  title: string
  pinned_at: number | null
  payload_json: string
  schema_version: number
  version: number
  created_at: number
  updated_at: number
}

export class TauriWorkspaceViewRepository implements WorkspaceViewRepository {
  constructor(private readonly sql: SqlClient) {}
  async create(input: {
    id: string
    parentId?: string | null
    sortOrder?: number
    viewType: StructuredWorkspaceViewType
    title: string
    payload: StructuredWorkspaceViewPayload
    createdAt?: number
  }): Promise<AppResult<StructuredWorkspaceView>> {
    const invalid = validate(input.title, input.viewType, input.payload)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    const now = input.createdAt ?? Date.now()
    try {
      await this.sql.execute(
        'INSERT INTO workspace_views (id, parent_id, sort_order, view_type, title, payload_json, schema_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        [
          input.id,
          input.parentId ?? null,
          input.sortOrder ?? 0,
          input.viewType,
          input.title.trim(),
          JSON.stringify(input.payload),
          now,
          now,
        ],
      )
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法创建工作空间视图。'))
    }
  }
  async get(id: string): Promise<AppResult<StructuredWorkspaceView>> {
    try {
      const rows = await this.sql.select<Row>(
        'SELECT * FROM workspace_views WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0] ? map(rows[0]) : err({ code: 'not-found', message: '工作空间视图不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取工作空间视图。'))
    }
  }
  async list(): Promise<AppResult<StructuredWorkspaceViewSummary[]>> {
    try {
      const rows = await this.sql.select<Row>(
        'SELECT * FROM workspace_views ORDER BY pinned_at DESC NULLS LAST, updated_at DESC, id ASC',
      )
      return ok(
        rows.map((row) => ({
          id: row.id,
          parentId: row.parent_id ?? null,
          sortOrder: Number(row.sort_order ?? 0),
          viewType: row.view_type,
          title: row.title,
          pinnedAt: row.pinned_at == null ? null : Number(row.pinned_at),
          version: Number(row.version),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        })),
      )
    } catch (error) {
      return err(normalizeError(error, '无法列出工作空间视图。'))
    }
  }
  async update(input: {
    id: string
    expectedVersion: number
    title: string
    payload: StructuredWorkspaceViewPayload
    updatedAt?: number
  }): Promise<AppResult<StructuredWorkspaceView>> {
    const current = await this.get(input.id)
    if (!current.ok) return current
    const invalid = validate(input.title, current.value.viewType, input.payload)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    try {
      const result = await this.sql.execute(
        'UPDATE workspace_views SET title = ?, payload_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
        [
          input.title.trim(),
          JSON.stringify(input.payload),
          input.updatedAt ?? Date.now(),
          input.id,
          input.expectedVersion,
        ],
      )
      if (result.rowsAffected !== 1)
        return err({ code: 'revision-conflict', message: '视图已更新，请重新打开。' })
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法保存工作空间视图。'))
    }
  }
  async move(input: {
    id: string
    expectedVersion: number
    parentId: string | null
    sortOrder?: number
    updatedAt?: number
  }): Promise<AppResult<StructuredWorkspaceView>> {
    if (input.id === input.parentId)
      return err({ code: 'validation-error', message: '视图不能成为自己的子页面。' })
    try {
      const result = await this.sql.execute(
        'UPDATE workspace_views SET parent_id = ?, sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
        [
          input.parentId,
          input.sortOrder ?? 0,
          input.updatedAt ?? Date.now(),
          input.id,
          input.expectedVersion,
        ],
      )
      if (result.rowsAffected !== 1)
        return err({ code: 'revision-conflict', message: '视图已更新，请重新打开。' })
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法移动视图。'))
    }
  }
  async setPinned(input: {
    id: string
    pinnedAt: number | null
  }): Promise<AppResult<StructuredWorkspaceView>> {
    try {
      const result = await this.sql.execute(
        'UPDATE workspace_views SET pinned_at = ? WHERE id = ?',
        [input.pinnedAt, input.id],
      )
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: '视图不存在。' })
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法更新视图置顶状态。'))
    }
  }
  async delete(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.execute('DELETE FROM workspace_views WHERE id = ?', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '视图不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除视图。'))
    }
  }
}

function validate(
  title: string,
  type: StructuredWorkspaceViewType,
  payload: StructuredWorkspaceViewPayload,
): string | null {
  if (!title.trim() || title.length > 160) return '视图标题不能为空且不能超过 160 个字符。'
  if (payload.type !== type) return '视图类型与 payload 不一致。'
  return validateWorkspaceViewPayload(payload)
}
function map(row: Row): AppResult<StructuredWorkspaceView> {
  try {
    const payload = parseJsonStrict<StructuredWorkspaceViewPayload>(
      row.payload_json,
      '工作空间视图数据',
    )
    const invalid = validate(row.title, row.view_type, payload)
    return invalid
      ? err({ code: 'validation-error', message: invalid })
      : ok({
          id: row.id,
          parentId: row.parent_id ?? null,
          sortOrder: Number(row.sort_order ?? 0),
          viewType: row.view_type,
          title: row.title,
          pinnedAt: row.pinned_at == null ? null : Number(row.pinned_at),
          payload,
          schemaVersion: 1,
          version: Number(row.version),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        })
  } catch (error) {
    return err({
      code: 'validation-error',
      message: error instanceof JsonCodecError ? error.message : '工作空间视图数据无效。',
      cause: error,
    })
  }
}
