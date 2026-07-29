import {
  normalizeInformationHomePayload,
  type InformationHome,
  type InformationHomePayload,
  type InformationHomeSummary,
} from '@/models/home/informationHome'
import { createEntityId } from '@/models/shared/id'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { InformationHomeRepository } from '@/repositories/home/InformationHomeRepository'
import type { SqlClient } from '@/repositories/shared/SqlClient'
import { parseJsonStrict } from '@/repositories/shared/jsonCodec'

interface InformationHomeRow extends Record<string, unknown> {
  id: 'default'
  payload_json: string
  schema_version: number
  version: number
  auto_summary_enabled: number
  summary_interval_minutes: number
  created_at: number
  updated_at: number
}

interface InformationHomeSummaryRow extends Record<string, unknown> {
  id: string
  home_id: 'default'
  source_cursor_at: number
  trigger_source: 'manual' | 'auto'
  status: 'completed' | 'failed'
  content: string
  provider: string
  model: string
  error: string | null
  generated_at: number
}

export class TauriInformationHomeRepository implements InformationHomeRepository {
  constructor(private readonly sql: SqlClient) {}

  async get(): Promise<AppResult<InformationHome>> {
    try {
      const rows = await this.sql.select<InformationHomeRow>(
        "SELECT * FROM information_home WHERE id = 'default' LIMIT 1",
      )
      return rows[0]
        ? ok(mapHome(rows[0]))
        : err({ code: 'not-found', message: '首页尚未初始化。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取首页配置。'))
    }
  }

  async create(home: InformationHome): Promise<AppResult<InformationHome>> {
    try {
      await this.sql.execute(
        `INSERT OR IGNORE INTO information_home (
          id, payload_json, schema_version, version, auto_summary_enabled,
          summary_interval_minutes, created_at, updated_at
        ) VALUES ('default', ?, 1, 1, ?, ?, ?, ?)`,
        [
          JSON.stringify(home.payload),
          home.autoSummaryEnabled ? 1 : 0,
          home.summaryIntervalMinutes,
          home.createdAt,
          home.updatedAt,
        ],
      )
      return this.get()
    } catch (error) {
      return err(normalizeError(error, '无法初始化首页。'))
    }
  }

  async updatePayload(
    payload: InformationHomePayload,
    expectedVersion: number,
    updatedAt: number,
  ): Promise<AppResult<InformationHome>> {
    try {
      const result = await this.sql.execute(
        `UPDATE information_home SET payload_json = ?, version = version + 1, updated_at = ?
         WHERE id = 'default' AND version = ?`,
        [JSON.stringify(payload), updatedAt, expectedVersion],
      )
      if (result.rowsAffected !== 1)
        return err({ code: 'conflict', message: '首页布局已在其他窗口更新，请刷新后重试。' })
      return this.get()
    } catch (error) {
      return err(normalizeError(error, '无法保存首页布局。'))
    }
  }

  async updateSummarySettings(
    enabled: boolean,
    intervalMinutes: number,
    updatedAt: number,
  ): Promise<AppResult<InformationHome>> {
    try {
      const result = await this.sql.execute(
        `UPDATE information_home SET auto_summary_enabled = ?, summary_interval_minutes = ?,
         version = version + 1, updated_at = ? WHERE id = 'default'`,
        [enabled ? 1 : 0, intervalMinutes, updatedAt],
      )
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: '首页尚未初始化。' })
      return this.get()
    } catch (error) {
      return err(normalizeError(error, '无法更新 Agent 摘要设置。'))
    }
  }

  async listSummaries(limit = 20): Promise<AppResult<InformationHomeSummary[]>> {
    try {
      const rows = await this.sql.select<InformationHomeSummaryRow>(
        `SELECT * FROM information_home_summaries WHERE home_id = 'default'
         ORDER BY generated_at DESC, id DESC LIMIT ?`,
        [Math.max(1, Math.min(limit, 100))],
      )
      return ok(rows.map(mapSummary))
    } catch (error) {
      return err(normalizeError(error, '无法读取 Agent 摘要。'))
    }
  }

  async createSummary(summary: InformationHomeSummary): Promise<AppResult<InformationHomeSummary>> {
    try {
      await this.sql.execute(
        `INSERT INTO information_home_summaries (
          id, home_id, source_cursor_at, trigger_source, status, content,
          provider, model, error, generated_at
        ) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          summary.id,
          summary.sourceCursorAt,
          summary.triggerSource,
          summary.status,
          summary.content,
          summary.provider,
          summary.model,
          summary.error,
          summary.generatedAt,
        ],
      )
      return ok(summary)
    } catch (error) {
      return err(normalizeError(error, '无法保存 Agent 摘要结果。'))
    }
  }
}

function mapHome(row: InformationHomeRow): InformationHome {
  const rawPayload = parseJsonStrict<unknown>(row.payload_json, '首页布局')
  return {
    id: 'default',
    payload: normalizeInformationHomePayload(rawPayload, createEntityId),
    schemaVersion: 1,
    version: Number(row.version),
    autoSummaryEnabled: Boolean(row.auto_summary_enabled),
    summaryIntervalMinutes: Number(row.summary_interval_minutes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapSummary(row: InformationHomeSummaryRow): InformationHomeSummary {
  return {
    id: row.id,
    homeId: 'default',
    sourceCursorAt: Number(row.source_cursor_at),
    triggerSource: row.trigger_source,
    status: row.status,
    content: row.content,
    provider: row.provider,
    model: row.model,
    error: row.error,
    generatedAt: Number(row.generated_at),
  }
}
