import type { MindMapContent, MindMapDocument, MindMapSummary } from '@/models/mindMap'
import { validateMindMapContent } from '@/models/mindMap'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import type { MindMapRepository } from '@/repositories/MindMapRepository'
import type { SqlClient } from '@/repositories/SqlClient'

interface MindMapRow extends Record<string, unknown> {
  id: string
  parent_id: string | null
  sort_order: number
  title: string
  content_json: string
  version: number
  created_at: number
  updated_at: number
}

export class TauriMindMapRepository implements MindMapRepository {
  constructor(private readonly sql: SqlClient) {}

  async create(input: {
    id: string
    parentId?: string | null
    sortOrder?: number
    title: string
    content: MindMapContent
    actorType: 'user' | 'agent' | 'system'
    actorId?: string | null
    createdAt?: number
  }): Promise<AppResult<MindMapDocument>> {
    const validation = validateInput(input.title, input.content)
    if (validation) return err({ code: 'validation-error', message: validation })
    const now = input.createdAt ?? Date.now()
    try {
      await this.sql.execute(
        `INSERT INTO mind_maps (
          id, parent_id, sort_order, title, content_json, schema_version, version,
          last_actor_type, last_actor_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        [
          input.id,
          input.parentId ?? null,
          input.sortOrder ?? 0,
          input.title.trim(),
          JSON.stringify(input.content),
          input.actorType,
          input.actorId ?? null,
          now,
          now,
        ],
      )
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法创建思维导图。'))
    }
  }

  async get(id: string): Promise<AppResult<MindMapDocument>> {
    try {
      const rows = await this.sql.select<MindMapRow>('SELECT * FROM mind_maps WHERE id = ? LIMIT 1', [id])
      if (!rows[0]) return err({ code: 'not-found', message: '思维导图不存在。' })
      return mapRow(rows[0])
    } catch (error) {
      return err(normalizeError(error, '无法读取思维导图。'))
    }
  }

  async list(): Promise<AppResult<MindMapSummary[]>> {
    try {
      const rows = await this.sql.select<MindMapRow>(
        'SELECT * FROM mind_maps ORDER BY updated_at DESC, id ASC',
      )
      const summaries: MindMapSummary[] = []
      for (const row of rows) {
        const mapped = mapRow(row)
        if (!mapped.ok) return mapped
        summaries.push({
          id: mapped.value.id,
          parentId: mapped.value.parentId,
          sortOrder: mapped.value.sortOrder,
          title: mapped.value.title,
          rootNodeId: mapped.value.content.rootNodeId,
          nodeCount: Object.keys(mapped.value.content.nodes).length,
          version: mapped.value.version,
          createdAt: mapped.value.createdAt,
          updatedAt: mapped.value.updatedAt,
        })
      }
      return ok(summaries)
    } catch (error) {
      return err(normalizeError(error, '无法列出思维导图。'))
    }
  }

  async move(input: {
    id: string
    expectedVersion: number
    parentId: string | null
    sortOrder?: number
    actorType: 'user' | 'agent' | 'system'
    actorId?: string | null
    updatedAt?: number
  }): Promise<AppResult<MindMapDocument>> {
    if (input.parentId === input.id) {
      return err({ code: 'validation-error', message: '思维导图不能成为自己的子页面。' })
    }
    try {
      const result = await this.sql.execute(
        `UPDATE mind_maps
         SET parent_id = ?, sort_order = ?,
             last_actor_type = ?, last_actor_id = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        [
          input.parentId,
          input.sortOrder ?? 0,
          input.actorType,
          input.actorId ?? null,
          input.updatedAt ?? Date.now(),
          input.id,
          input.expectedVersion,
        ],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'revision-conflict', message: '思维导图已被其他操作更新，请重新加载。' })
      }
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法移动思维导图。'))
    }
  }

  async update(input: {
    id: string
    expectedVersion: number
    title: string
    content: MindMapContent
    actorType: 'user' | 'agent' | 'system'
    actorId?: string | null
    updatedAt?: number
  }): Promise<AppResult<MindMapDocument>> {
    const validation = validateInput(input.title, input.content)
    if (validation) return err({ code: 'validation-error', message: validation })
    try {
      const result = await this.sql.execute(
        `UPDATE mind_maps
         SET title = ?, content_json = ?, version = version + 1,
             last_actor_type = ?, last_actor_id = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        [
          input.title.trim(),
          JSON.stringify(input.content),
          input.actorType,
          input.actorId ?? null,
          input.updatedAt ?? Date.now(),
          input.id,
          input.expectedVersion,
        ],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'revision-conflict', message: '思维导图已被其他操作更新，请重新加载。' })
      }
      return this.get(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法保存思维导图。'))
    }
  }

  async delete(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.execute('DELETE FROM mind_maps WHERE id = ?', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: '思维导图不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除思维导图。'))
    }
  }
}

function validateInput(title: string, content: MindMapContent): string | null {
  if (!title.trim()) return '思维导图标题不能为空。'
  if (title.length > 160) return '思维导图标题不能超过 160 个字符。'
  return validateMindMapContent(content)
}

function mapRow(row: MindMapRow): AppResult<MindMapDocument> {
  try {
    const content = JSON.parse(row.content_json) as MindMapContent
    const validation = validateMindMapContent(content)
    if (validation) return err({ code: 'validation-error', message: `思维导图数据损坏：${validation}` })
    return ok({
      id: row.id,
      parentId: row.parent_id ?? null,
      sortOrder: Number(row.sort_order ?? 0),
      title: row.title,
      content,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })
  } catch (error) {
    return err({ code: 'validation-error', message: '思维导图 JSON 无法解析。', cause: error })
  }
}
