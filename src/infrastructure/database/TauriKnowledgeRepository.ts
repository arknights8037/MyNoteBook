import type {
  CreateKnowledgeObjectInput,
  KnowledgeObject,
  KnowledgeObjectStatus,
  KnowledgeObjectType,
  KnowledgeRelation,
  KnowledgeRelationType,
  KnowledgeObjectSource,
  KnowledgeValidation,
} from '@/models/knowledge'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import type { KnowledgeRepository } from '@/repositories/KnowledgeRepository'
import type { SqlClient } from '@/repositories/SqlClient'

interface KnowledgeRow extends Record<string, unknown> {
  id: string
  object_type: KnowledgeObjectType
  status: KnowledgeObjectStatus
  title: string
  content: string
  structured_data_json: string
  generated_run_id: string | null
  cognitive_mode: KnowledgeObject['cognitiveMode']
  template_id: string | null
  template_version: number | null
  owner_id: string | null
  scope_json: string
  document_id: string | null
  block_id: string | null
  source_revision: number | null
  authority_level: string
  confidence: number | null
  valid_from: number | null
  valid_until: number | null
  verified_at: number | null
  version: number
  created_at: number
  updated_at: number
}

interface RelationRow extends Record<string, unknown> {
  id: string
  from_object_id: string
  relation_type: KnowledgeRelationType
  to_object_id: string
  created_at: number
}

interface SourceRow extends Record<string, unknown> {
  id: string
  knowledge_object_id: string
  document_id: string
  block_id: string | null
  revision: number
  quote: string | null
  start_offset: number | null
  end_offset: number | null
  created_at: number
}

interface ValidationRow extends Record<string, unknown> {
  id: string
  knowledge_object_id: string
  rule_id: string
  verdict: KnowledgeValidation['verdict']
  severity: KnowledgeValidation['severity']
  message: string
  source_json: string
  validated_at: number
}

export class TauriKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async createObject(input: CreateKnowledgeObjectInput): Promise<AppResult<KnowledgeObject>> {
    const validation = validateInput(input)
    if (validation) return err({ code: 'validation-error', message: validation })
    const now = input.createdAt ?? Date.now()
    try {
      await this.sqlClient.execute(
        `INSERT INTO knowledge_objects (
          id, object_type, status, title, content, structured_data_json, generated_run_id,
          cognitive_mode, template_id, template_version, owner_id, scope_json, document_id, block_id,
          source_revision, authority_level, confidence, valid_from, valid_until,
          verified_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.id,
          input.objectType,
          input.status ?? 'draft',
          input.title.trim(),
          input.content?.trim() ?? '',
          JSON.stringify(input.structuredData ?? {}),
          input.generatedRunId ?? null,
          input.cognitiveMode ?? null,
          input.templateId ?? null,
          input.templateVersion ?? null,
          input.ownerId ?? null,
          JSON.stringify(input.scope ?? {}),
          input.documentId ?? null,
          input.blockId ?? null,
          input.sourceRevision ?? null,
          input.authorityLevel?.trim() || 'local',
          input.confidence ?? null,
          input.validFrom ?? null,
          input.validUntil ?? null,
          input.verifiedAt ?? null,
          now,
          now,
        ],
      )
      return this.getObject(input.id)
    } catch (error) {
      return err(normalizeError(error, '无法创建知识对象。'))
    }
  }

  async getObject(id: string): Promise<AppResult<KnowledgeObject>> {
    try {
      const rows = await this.sqlClient.select<KnowledgeRow>(
        'SELECT * FROM knowledge_objects WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapKnowledgeRow(rows[0]))
        : err({ code: 'not-found', message: '知识对象不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取知识对象。'))
    }
  }

  async listObjects(
    options: {
      types?: KnowledgeObjectType[]
      documentId?: string
      effectiveAt?: number
      limit?: number
    } = {},
  ): Promise<AppResult<KnowledgeObject[]>> {
    const conditions: string[] = ['1 = 1']
    const values: Array<string | number | null> = []
    if (options.types?.length) {
      conditions.push(`object_type IN (${options.types.map(() => '?').join(', ')})`)
      values.push(...options.types)
    }
    if (options.documentId) {
      conditions.push('(document_id = ? OR document_id IS NULL)')
      values.push(options.documentId)
    }
    if (options.effectiveAt !== undefined) {
      conditions.push("status IN ('approved', 'active')")
      conditions.push('(valid_from IS NULL OR valid_from <= ?)')
      conditions.push('(valid_until IS NULL OR valid_until > ?)')
      values.push(options.effectiveAt, options.effectiveAt)
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
    values.push(limit)
    try {
      const rows = await this.sqlClient.select<KnowledgeRow>(
        `SELECT * FROM knowledge_objects WHERE ${conditions.join(' AND ')}
         ORDER BY authority_level DESC, updated_at DESC, id ASC LIMIT ?`,
        values,
      )
      return ok(rows.map(mapKnowledgeRow))
    } catch (error) {
      return err(normalizeError(error, '无法列出知识对象。'))
    }
  }

  async updateObject(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<CreateKnowledgeObjectInput, 'id' | 'objectType'>>,
  ): Promise<AppResult<KnowledgeObject>> {
    const current = await this.getObject(id)
    if (!current.ok) return err(current.error)
    if (current.value.version !== expectedVersion) {
      return err({ code: 'revision-conflict', message: '知识对象版本已变化。' })
    }
    if (
      patch.status &&
      patch.status !== current.value.status &&
      !isAllowedStatusTransition(current.value.status, patch.status)
    ) {
      return err({
        code: 'validation-error',
        message: `知识对象不能从 ${current.value.status} 转为 ${patch.status}。`,
      })
    }
    const next: CreateKnowledgeObjectInput = {
      id,
      objectType: current.value.objectType,
      status: patch.status ?? current.value.status,
      title: patch.title ?? current.value.title,
      content: patch.content ?? current.value.content,
      structuredData: patch.structuredData ?? current.value.structuredData,
      generatedRunId:
        patch.generatedRunId === undefined ? current.value.generatedRunId : patch.generatedRunId,
      cognitiveMode:
        patch.cognitiveMode === undefined ? current.value.cognitiveMode : patch.cognitiveMode,
      templateId: patch.templateId === undefined ? current.value.templateId : patch.templateId,
      templateVersion:
        patch.templateVersion === undefined ? current.value.templateVersion : patch.templateVersion,
      ownerId: patch.ownerId === undefined ? current.value.ownerId : patch.ownerId,
      scope: patch.scope ?? current.value.scope,
      documentId: patch.documentId === undefined ? current.value.documentId : patch.documentId,
      blockId: patch.blockId === undefined ? current.value.blockId : patch.blockId,
      sourceRevision:
        patch.sourceRevision === undefined ? current.value.sourceRevision : patch.sourceRevision,
      authorityLevel: patch.authorityLevel ?? current.value.authorityLevel,
      confidence: patch.confidence === undefined ? current.value.confidence : patch.confidence,
      validFrom: patch.validFrom === undefined ? current.value.validFrom : patch.validFrom,
      validUntil: patch.validUntil === undefined ? current.value.validUntil : patch.validUntil,
      verifiedAt: patch.verifiedAt === undefined ? current.value.verifiedAt : patch.verifiedAt,
    }
    const validation = validateInput(next)
    if (validation) return err({ code: 'validation-error', message: validation })
    try {
      const updatedAt = Date.now()
      const result = await this.sqlClient.execute(
        `UPDATE knowledge_objects SET status = ?, title = ?, content = ?, structured_data_json = ?,
          generated_run_id = ?, cognitive_mode = ?, template_id = ?, template_version = ?, owner_id = ?, scope_json = ?,
          document_id = ?, block_id = ?, source_revision = ?, authority_level = ?, confidence = ?,
          valid_from = ?, valid_until = ?, verified_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
        [
          next.status ?? 'draft',
          next.title.trim(),
          next.content?.trim() ?? '',
          JSON.stringify(next.structuredData ?? {}),
          next.generatedRunId ?? null,
          next.cognitiveMode ?? null,
          next.templateId ?? null,
          next.templateVersion ?? null,
          next.ownerId ?? null,
          JSON.stringify(next.scope ?? {}),
          next.documentId ?? null,
          next.blockId ?? null,
          next.sourceRevision ?? null,
          next.authorityLevel ?? 'local',
          next.confidence ?? null,
          next.validFrom ?? null,
          next.validUntil ?? null,
          next.verifiedAt ?? null,
          updatedAt,
          id,
          expectedVersion,
        ],
      )
      if (result.rowsAffected !== 1) {
        return err({ code: 'revision-conflict', message: '知识对象版本已变化。' })
      }
      return this.getObject(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新知识对象。'))
    }
  }

  async deleteObject(id: string, expectedVersion: number): Promise<AppResult<void>> {
    const current = await this.getObject(id)
    if (!current.ok) return current
    if (current.value.version !== expectedVersion) {
      return err({ code: 'revision-conflict', message: '知识对象版本已变化。' })
    }
    try {
      await this.sqlClient.execute(
        'DELETE FROM knowledge_object_relations WHERE from_object_id = ? OR to_object_id = ?',
        [id, id],
      )
      await this.sqlClient.execute(
        'DELETE FROM knowledge_object_sources WHERE knowledge_object_id = ?',
        [id],
      )
      await this.sqlClient.execute(
        'DELETE FROM knowledge_validations WHERE knowledge_object_id = ?',
        [id],
      )
      const result = await this.sqlClient.execute(
        'DELETE FROM knowledge_objects WHERE id = ? AND version = ?',
        [id, expectedVersion],
      )
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'revision-conflict', message: '知识对象不存在或版本已变化。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除知识对象。'))
    }
  }

  async addRelation(input: {
    id: string
    fromObjectId: string
    relationType: KnowledgeRelationType
    toObjectId: string
    createdAt?: number
  }): Promise<AppResult<KnowledgeRelation>> {
    if (input.fromObjectId === input.toObjectId) {
      return err({ code: 'validation-error', message: '知识对象不能关联自身。' })
    }
    const relation: KnowledgeRelation = { ...input, createdAt: input.createdAt ?? Date.now() }
    try {
      await this.sqlClient.execute(
        `INSERT INTO knowledge_object_relations
         (id, from_object_id, relation_type, to_object_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        [
          relation.id,
          relation.fromObjectId,
          relation.relationType,
          relation.toObjectId,
          relation.createdAt,
        ],
      )
      return ok(relation)
    } catch (error) {
      return err(normalizeError(error, '无法创建知识关系。'))
    }
  }

  async listRelations(objectId: string): Promise<AppResult<KnowledgeRelation[]>> {
    try {
      const rows = await this.sqlClient.select<RelationRow>(
        `SELECT * FROM knowledge_object_relations
         WHERE from_object_id = ? OR to_object_id = ? ORDER BY created_at ASC`,
        [objectId, objectId],
      )
      return ok(rows.map(mapRelationRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取知识关系。'))
    }
  }

  async decideCandidate(input: {
    id: string
    expectedVersion: number
    decision: 'approved' | 'rejected'
  }): Promise<AppResult<KnowledgeObject>> {
    const current = await this.getObject(input.id)
    if (!current.ok) return current
    if (current.value.status !== 'candidate') {
      return err({ code: 'validation-error', message: '只有 candidate 可以接受或拒绝。' })
    }
    return this.updateObject(input.id, input.expectedVersion, { status: input.decision })
  }

  async addSource(input: KnowledgeObjectSource): Promise<AppResult<KnowledgeObjectSource>> {
    if (
      !input.id.trim() ||
      !input.knowledgeObjectId.trim() ||
      !input.documentId.trim() ||
      input.revision < 1
    ) {
      return err({ code: 'validation-error', message: '知识来源缺少有效 ID、文档或 revision。' })
    }
    try {
      await this.sqlClient.execute(
        `INSERT INTO knowledge_object_sources
         (id, knowledge_object_id, document_id, block_id, revision, quote, start_offset, end_offset, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.knowledgeObjectId,
          input.documentId,
          input.blockId,
          input.revision,
          input.quote,
          input.startOffset,
          input.endOffset,
          input.createdAt,
        ],
      )
      return ok(input)
    } catch (error) {
      return err(normalizeError(error, '无法保存知识来源。'))
    }
  }

  async listSources(objectId: string): Promise<AppResult<KnowledgeObjectSource[]>> {
    try {
      const rows = await this.sqlClient.select<SourceRow>(
        'SELECT * FROM knowledge_object_sources WHERE knowledge_object_id = ? ORDER BY created_at ASC, id ASC',
        [objectId],
      )
      return ok(rows.map(mapSourceRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取知识来源。'))
    }
  }

  async addValidation(input: KnowledgeValidation): Promise<AppResult<KnowledgeValidation>> {
    try {
      await this.sqlClient.execute(
        `INSERT INTO knowledge_validations
         (id, knowledge_object_id, rule_id, verdict, severity, message, source_json, validated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.knowledgeObjectId,
          input.ruleId,
          input.verdict,
          input.severity,
          input.message,
          JSON.stringify(input.source),
          input.validatedAt,
        ],
      )
      return ok(input)
    } catch (error) {
      return err(normalizeError(error, '无法保存知识验证。'))
    }
  }

  async listValidations(objectId: string): Promise<AppResult<KnowledgeValidation[]>> {
    try {
      const rows = await this.sqlClient.select<ValidationRow>(
        'SELECT * FROM knowledge_validations WHERE knowledge_object_id = ? ORDER BY validated_at DESC, id ASC',
        [objectId],
      )
      return ok(rows.map(mapValidationRow))
    } catch (error) {
      return err(normalizeError(error, '无法读取知识验证。'))
    }
  }
}

function validateInput(input: CreateKnowledgeObjectInput): string | null {
  if (!input.id.trim() || !input.title.trim()) return '知识对象 ID 和标题不能为空。'
  if (input.blockId && !input.documentId) return 'blockId 必须与 documentId 一起保存。'
  if (
    input.sourceRevision !== null &&
    input.sourceRevision !== undefined &&
    input.sourceRevision < 1
  ) {
    return '来源 revision 必须大于 0。'
  }
  if (input.confidence !== null && input.confidence !== undefined) {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      return 'confidence 必须位于 0 到 1。'
    }
  }
  if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) {
    return '有效期结束时间必须晚于开始时间。'
  }
  if (
    input.templateVersion !== null &&
    input.templateVersion !== undefined &&
    input.templateVersion < 1
  ) {
    return 'templateVersion 必须大于 0。'
  }
  return null
}

function isAllowedStatusTransition(
  from: KnowledgeObjectStatus,
  to: KnowledgeObjectStatus,
): boolean {
  const transitions: Record<KnowledgeObjectStatus, KnowledgeObjectStatus[]> = {
    draft: ['candidate', 'approved', 'active', 'deprecated'],
    candidate: ['approved', 'rejected', 'deprecated'],
    approved: ['active', 'deprecated'],
    active: ['deprecated'],
    deprecated: [],
    rejected: [],
  }
  return transitions[from].includes(to)
}

function mapKnowledgeRow(row: KnowledgeRow): KnowledgeObject {
  return {
    id: row.id,
    objectType: row.object_type,
    status: row.status,
    title: row.title,
    content: row.content,
    structuredData: parseObject(row.structured_data_json),
    generatedRunId: row.generated_run_id,
    cognitiveMode: row.cognitive_mode,
    templateId: row.template_id,
    templateVersion: row.template_version,
    ownerId: row.owner_id,
    scope: parseObject(row.scope_json),
    documentId: row.document_id,
    blockId: row.block_id,
    sourceRevision: row.source_revision,
    authorityLevel: row.authority_level,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    verifiedAt: row.verified_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSourceRow(row: SourceRow): KnowledgeObjectSource {
  return {
    id: row.id,
    knowledgeObjectId: row.knowledge_object_id,
    documentId: row.document_id,
    blockId: row.block_id,
    revision: row.revision,
    quote: row.quote,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    createdAt: row.created_at,
  }
}

function mapValidationRow(row: ValidationRow): KnowledgeValidation {
  return {
    id: row.id,
    knowledgeObjectId: row.knowledge_object_id,
    ruleId: row.rule_id,
    verdict: row.verdict,
    severity: row.severity,
    message: row.message,
    source: parseObject(row.source_json),
    validatedAt: row.validated_at,
  }
}

function mapRelationRow(row: RelationRow): KnowledgeRelation {
  return {
    id: row.id,
    fromObjectId: row.from_object_id,
    relationType: row.relation_type,
    toObjectId: row.to_object_id,
    createdAt: row.created_at,
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
