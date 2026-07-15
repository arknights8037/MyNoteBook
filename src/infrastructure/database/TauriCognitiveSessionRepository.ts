import type {
  CognitiveModeId,
  CognitiveSession,
  CognitiveSessionStatus,
  CreateCognitiveSessionInput,
} from '@/models/cognitive'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import type { CognitiveSessionRepository } from '@/repositories/CognitiveSessionRepository'
import type { SqlClient } from '@/repositories/SqlClient'

interface CognitiveSessionRow extends Record<string, unknown> {
  id: string
  conversation_id: string
  mode_id: CognitiveModeId
  mode_version: number
  template_id: string | null
  template_version: number | null
  skill_ids_json: string
  target_document_ids_json: string
  target_block_ids_json: string
  state_json: string
  status: CognitiveSessionStatus
  version: number
  created_at: number
  updated_at: number
}

export class TauriCognitiveSessionRepository implements CognitiveSessionRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async create(input: CreateCognitiveSessionInput): Promise<AppResult<CognitiveSession>> {
    if (!input.id.trim() || !input.conversationId.trim() || input.modeVersion < 1) {
      return err({
        code: 'validation-error',
        message: 'Cognitive Session 缺少有效 ID、会话或模式版本。',
      })
    }
    const now = input.createdAt ?? Date.now()
    try {
      await this.sqlClient.execute(
        `INSERT INTO cognitive_sessions
         (id, conversation_id, mode_id, mode_version, template_id, template_version,
          skill_ids_json, target_document_ids_json, target_block_ids_json, state_json,
          status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.id,
          input.conversationId,
          input.modeId,
          input.modeVersion,
          input.templateId,
          input.templateVersion,
          JSON.stringify(input.skillIds),
          JSON.stringify(input.targetDocumentIds),
          JSON.stringify(input.targetBlockIds),
          JSON.stringify(input.state),
          input.status ?? 'active',
          now,
          now,
        ],
      )
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法创建 Cognitive Session。'))
    }
  }

  async get(id: string): Promise<AppResult<CognitiveSession>> {
    try {
      const rows = await this.sqlClient.select<CognitiveSessionRow>(
        'SELECT * FROM cognitive_sessions WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapSession(rows[0]))
        : err({ code: 'not-found', message: 'Cognitive Session 不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取 Cognitive Session。'))
    }
  }

  async listByConversation(conversationId: string): Promise<AppResult<CognitiveSession[]>> {
    try {
      const rows = await this.sqlClient.select<CognitiveSessionRow>(
        'SELECT * FROM cognitive_sessions WHERE conversation_id = ? ORDER BY updated_at DESC, id ASC',
        [conversationId],
      )
      return ok(rows.map(mapSession))
    } catch (error) {
      return err(normalizeError(error, '无法列出 Cognitive Session。'))
    }
  }

  async update(input: {
    id: string
    expectedVersion: number
    state?: Record<string, unknown>
    status?: CognitiveSessionStatus
    updatedAt?: number
  }): Promise<AppResult<CognitiveSession>> {
    const current = await this.get(input.id)
    if (!current.ok) return current
    const status = input.status ?? current.value.status
    if (!isAllowedTransition(current.value.status, status)) {
      return err({
        code: 'validation-error',
        message: `Cognitive Session 不能从 ${current.value.status} 转为 ${status}。`,
      })
    }
    try {
      const result = await this.sqlClient.execute(
        `UPDATE cognitive_sessions SET state_json = ?, status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
        [
          JSON.stringify(input.state ?? current.value.state),
          status,
          input.updatedAt ?? Date.now(),
          input.id,
          input.expectedVersion,
        ],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'revision-conflict', message: 'Cognitive Session 版本已变化。' })
      }
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法更新 Cognitive Session。'))
    }
  }
}

function isAllowedTransition(from: CognitiveSessionStatus, to: CognitiveSessionStatus): boolean {
  if (from === to) return true
  if (from === 'active') return ['waiting_user', 'completed', 'cancelled'].includes(to)
  if (from === 'waiting_user') return ['active', 'completed', 'cancelled'].includes(to)
  return false
}

function mapSession(row: CognitiveSessionRow): CognitiveSession {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    modeId: row.mode_id,
    modeVersion: row.mode_version,
    templateId: row.template_id,
    templateVersion: row.template_version,
    skillIds: parseStringArray(row.skill_ids_json),
    targetDocumentIds: parseStringArray(row.target_document_ids_json),
    targetBlockIds: parseStringArray(row.target_block_ids_json),
    state: parseObject(row.state_json),
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
