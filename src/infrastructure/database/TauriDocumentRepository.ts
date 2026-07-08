import {
  DOCUMENT_SCHEMA_VERSION,
  EMPTY_TIPTAP_DOCUMENT,
  type CreateDocumentInput,
  type DocumentId,
  type DocumentRecord,
  type DocumentSummary,
  type SaveDocumentInput,
  type UpdateDocumentInput,
} from '@/models/document'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { SqlClient } from '@/repositories/SqlClient'
import { parseEditorContentJson, serializeEditorContent } from '@/editor/editorContent'

interface DocumentRow extends Record<string, unknown> {
  id: string
  parent_id: string | null
  document_kind?: string
  title: string
  source_url?: string
  author?: string
  description?: string
  content_json: string
  plain_text: string
  schema_version: number
  revision: number
  sort_order: number
  is_deleted: number
  created_at: number
  updated_at: number
}

const DEFAULT_CONTENT_JSON = serializeEditorContent(EMPTY_TIPTAP_DOCUMENT)

export class TauriDocumentRepository implements DocumentRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async create(input: CreateDocumentInput): Promise<AppResult<DocumentRecord>> {
    const now = Date.now()
    const document: DocumentRecord = {
      id: input.id,
      parentId: input.parentId ?? null,
      documentKind: input.documentKind ?? 'article',
      title: input.title ?? '',
      tags: normalizeTags(input.tags),
      sourceUrl: input.sourceUrl ?? '',
      author: input.author ?? '',
      description: input.description ?? '',
      contentJson: normalizeContentJson(input.contentJson),
      plainText: input.plainText ?? '',
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      revision: 1,
      sortOrder: input.sortOrder ?? 0,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await this.sqlClient.execute(
        `INSERT INTO documents (
          id,
          parent_id,
          document_kind,
          title,
          source_url,
          author,
          description,
          content_json,
          plain_text,
          schema_version,
          revision,
          sort_order,
          is_deleted,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          document.id,
          document.parentId,
          document.documentKind,
          document.title,
          document.sourceUrl,
          document.author,
          document.description,
          document.contentJson,
          document.plainText,
          document.schemaVersion,
          document.revision,
          document.sortOrder,
          document.isDeleted ? 1 : 0,
          document.createdAt,
          document.updatedAt,
        ],
      )
      await this.syncDocumentTags(document.id, document.tags)

      return ok(document)
    } catch (error) {
      return err(normalizeError(error, 'Failed to create document.'))
    }
  }

  async findById(
    id: DocumentId,
    options: { includeDeleted?: boolean } = {},
  ): Promise<AppResult<DocumentRecord>> {
    try {
      const rows = await this.sqlClient.select<DocumentRow>(
        `SELECT *
         FROM documents
         WHERE id = ? ${options.includeDeleted ? '' : 'AND is_deleted = 0'}
         LIMIT 1`,
        [id],
      )

      const row = rows[0]
      if (!row) {
        return err({ code: 'not-found', message: `Document "${id}" was not found.` })
      }

      return ok(await this.mapDocumentRow(row))
    } catch (error) {
      return err(normalizeError(error, 'Failed to find document.'))
    }
  }

  async listByParent(
    parentId: DocumentId | null,
    options: { includeDeleted?: boolean } = {},
  ): Promise<AppResult<DocumentSummary[]>> {
    try {
      const rows = await this.sqlClient.select<DocumentRow>(
        `SELECT *
         FROM documents
         WHERE ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'}
           ${options.includeDeleted ? '' : 'AND is_deleted = 0'}
         ORDER BY sort_order ASC, updated_at DESC`,
        parentId === null ? [] : [parentId],
      )

      return ok(await Promise.all(rows.map((row) => this.mapDocumentSummaryRow(row))))
    } catch (error) {
      return err(normalizeError(error, 'Failed to list documents.'))
    }
  }

  async listRecent(
    options: { includeDeleted?: boolean; limit?: number } = {},
  ): Promise<AppResult<DocumentSummary[]>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))

    try {
      const rows = await this.sqlClient.select<DocumentRow>(
        `SELECT *
         FROM documents
         WHERE ${options.includeDeleted ? '1 = 1' : 'is_deleted = 0'}
         ORDER BY updated_at DESC
         LIMIT ?`,
        [limit],
      )

      return ok(await Promise.all(rows.map((row) => this.mapDocumentSummaryRow(row))))
    } catch (error) {
      return err(normalizeError(error, 'Failed to list recent documents.'))
    }
  }

  async listDeleted(options: { limit?: number } = {}): Promise<AppResult<DocumentSummary[]>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))

    try {
      const rows = await this.sqlClient.select<DocumentRow>(
        `SELECT *
         FROM documents
         WHERE is_deleted = 1
         ORDER BY updated_at DESC
         LIMIT ?`,
        [limit],
      )

      return ok(await Promise.all(rows.map((row) => this.mapDocumentSummaryRow(row))))
    } catch (error) {
      return err(normalizeError(error, 'Failed to list deleted documents.'))
    }
  }

  async update(input: UpdateDocumentInput): Promise<AppResult<DocumentRecord>> {
    const existingResult = await this.findById(input.id, { includeDeleted: true })
    if (!existingResult.ok) {
      return existingResult
    }

    const existing = existingResult.value
    if (existing.revision !== input.expectedRevision) {
      return err({
        code: 'revision-conflict',
        message: `Document "${input.id}" has revision ${existing.revision}, expected ${input.expectedRevision}.`,
      })
    }

    const nextDocument: DocumentRecord = {
      ...existing,
      parentId: input.parentId === undefined ? existing.parentId : input.parentId,
      documentKind: input.documentKind ?? existing.documentKind,
      title: input.title ?? existing.title,
      tags: input.tags === undefined ? existing.tags : normalizeTags(input.tags),
      sourceUrl: input.sourceUrl ?? existing.sourceUrl,
      author: input.author ?? existing.author,
      description: input.description ?? existing.description,
      contentJson: input.contentJson === undefined ? existing.contentJson : normalizeContentJson(input.contentJson),
      plainText: input.plainText ?? existing.plainText,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      revision: existing.revision + 1,
      updatedAt: Date.now(),
    }

    return this.persistExistingDocument(nextDocument, input.expectedRevision)
  }

  async save(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>> {
    const now = Date.now()
    const expectedRevision = input.expectedRevision ?? -1
    const insertRevision = 1

    try {
      const result = await this.sqlClient.execute(
        `INSERT INTO documents (
          id,
          parent_id,
          document_kind,
          title,
          source_url,
          author,
          description,
          content_json,
          plain_text,
          schema_version,
          revision,
          sort_order,
          is_deleted,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          parent_id = excluded.parent_id,
          document_kind = excluded.document_kind,
          title = excluded.title,
          source_url = excluded.source_url,
          author = excluded.author,
          description = excluded.description,
          content_json = excluded.content_json,
          plain_text = excluded.plain_text,
          schema_version = excluded.schema_version,
          revision = documents.revision + 1,
          sort_order = excluded.sort_order,
          is_deleted = 0,
          updated_at = excluded.updated_at
        WHERE documents.revision = ? AND documents.is_deleted = 0`,
        [
          input.id,
          input.parentId ?? null,
          input.documentKind ?? 'article',
          input.title,
          input.sourceUrl ?? '',
          input.author ?? '',
          input.description ?? '',
          normalizeContentJson(input.contentJson),
          input.plainText,
          DOCUMENT_SCHEMA_VERSION,
          insertRevision,
          input.sortOrder ?? 0,
          now,
          now,
          expectedRevision,
        ],
      )

      if (result.rowsAffected !== 1) {
        return err({
          code: 'revision-conflict',
          message: `Document "${input.id}" was changed before autosave completed.`,
        })
      }
      if (input.tags !== undefined) {
        await this.syncDocumentTags(input.id, normalizeTags(input.tags))
      }

      return this.findById(input.id)
    } catch (error) {
      return err(normalizeError(error, 'Failed to save document.'))
    }
  }

  async softDelete(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    return this.setDeletedState(id, expectedRevision, true)
  }

  async restore(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    return this.setDeletedState(id, expectedRevision, false)
  }

  async hardDelete(id: DocumentId, expectedRevision: number): Promise<AppResult<DocumentRecord>> {
    const existingResult = await this.findById(id, { includeDeleted: true })
    if (!existingResult.ok) {
      return existingResult
    }

    const existing = existingResult.value
    if (!existing.isDeleted) {
      return err({
        code: 'validation-error',
        message: `Document "${id}" is not in trash.`,
      })
    }

    if (existing.revision !== expectedRevision) {
      return err({
        code: 'revision-conflict',
        message: `Document "${id}" has revision ${existing.revision}, expected ${expectedRevision}.`,
      })
    }

    try {
      const result = await this.sqlClient.execute(
        `DELETE FROM documents
         WHERE id = ? AND revision = ? AND is_deleted = 1`,
        [id, expectedRevision],
      )

      if (result.rowsAffected !== 1) {
        return err({
          code: 'revision-conflict',
          message: `Document "${id}" was changed before deletion completed.`,
        })
      }

      return ok(existing)
    } catch (error) {
      return err(normalizeError(error, 'Failed to permanently delete document.'))
    }
  }

  private async setDeletedState(
    id: DocumentId,
    expectedRevision: number,
    isDeleted: boolean,
  ): Promise<AppResult<DocumentRecord>> {
    const existingResult = await this.findById(id, { includeDeleted: true })
    if (!existingResult.ok) {
      return existingResult
    }

    const existing = existingResult.value
    if (existing.revision !== expectedRevision) {
      return err({
        code: 'revision-conflict',
        message: `Document "${id}" has revision ${existing.revision}, expected ${expectedRevision}.`,
      })
    }

    return this.persistExistingDocument(
      {
        ...existing,
        isDeleted,
        revision: existing.revision + 1,
        updatedAt: Date.now(),
      },
      expectedRevision,
    )
  }

  private async persistExistingDocument(
    document: DocumentRecord,
    expectedRevision: number,
  ): Promise<AppResult<DocumentRecord>> {
    try {
      const result = await this.sqlClient.execute(
        `UPDATE documents
         SET parent_id = ?,
             document_kind = ?,
             title = ?,
             source_url = ?,
             author = ?,
             description = ?,
             content_json = ?,
             plain_text = ?,
             schema_version = ?,
             revision = ?,
             sort_order = ?,
             is_deleted = ?,
             updated_at = ?
         WHERE id = ? AND revision = ?`,
        [
          document.parentId,
          document.documentKind,
          document.title,
          document.sourceUrl,
          document.author,
          document.description,
          document.contentJson,
          document.plainText,
          document.schemaVersion,
          document.revision,
          document.sortOrder,
          document.isDeleted ? 1 : 0,
          document.updatedAt,
          document.id,
          expectedRevision,
        ],
      )

      if (result.rowsAffected !== 1) {
        return err({
          code: 'revision-conflict',
          message: `Document "${document.id}" was changed before the update completed.`,
        })
      }
      await this.syncDocumentTags(document.id, document.tags)

      return ok(document)
    } catch (error) {
      return err(normalizeError(error, 'Failed to persist document.'))
    }
  }

  private async mapDocumentRow(row: DocumentRow): Promise<DocumentRecord> {
    return {
      ...mapDocumentBase(row),
      tags: await this.listDocumentTags(row.id),
      contentJson: normalizeContentJson(row.content_json),
      schemaVersion: Math.max(row.schema_version, DOCUMENT_SCHEMA_VERSION),
    }
  }

  private async mapDocumentSummaryRow(row: DocumentRow): Promise<DocumentSummary> {
    return {
      ...mapDocumentBase(row),
      tags: await this.listDocumentTags(row.id),
    }
  }

  private async listDocumentTags(documentId: DocumentId): Promise<string[]> {
    const rows = await this.sqlClient.select<{ name: string }>(
      `SELECT tags.name
       FROM tags
       INNER JOIN document_tags ON document_tags.tag_id = tags.id
       WHERE document_tags.document_id = ?
       ORDER BY tags.name COLLATE NOCASE ASC`,
      [documentId],
    )
    return rows.map((row) => row.name)
  }

  private async syncDocumentTags(documentId: DocumentId, tags: string[]): Promise<void> {
    const normalizedTags = normalizeTags(tags)
    await this.sqlClient.execute('DELETE FROM document_tags WHERE document_id = ?', [documentId])

    const now = Date.now()
    for (const tag of normalizedTags) {
      const tagId = createTagId(tag)
      await this.sqlClient.execute(
        `INSERT INTO tags (id, name, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
        [tagId, tag, now],
      )
      const rows = await this.sqlClient.select<{ id: string }>(
        'SELECT id FROM tags WHERE name = ? LIMIT 1',
        [tag],
      )
      const resolvedTagId = rows[0]?.id ?? tagId
      await this.sqlClient.execute(
        `INSERT OR IGNORE INTO document_tags (document_id, tag_id, created_at)
         VALUES (?, ?, ?)`,
        [documentId, resolvedTagId, now],
      )
    }
  }
}

function mapDocumentBase(row: DocumentRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    documentKind: mapDocumentKind(row.document_kind),
    title: row.title,
    sourceUrl: row.source_url ?? '',
    author: row.author ?? '',
    description: row.description ?? '',
    plainText: row.plain_text,
    revision: row.revision,
    sortOrder: row.sort_order,
    isDeleted: row.is_deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeTags(tags: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .map((tag) => tag.slice(0, 40)),
    ),
  ).slice(0, 20)
}

function createTagId(tag: string): string {
  const safeTag = tag
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const randomId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `tag-${safeTag || 'item'}-${randomId}`
}

function mapDocumentKind(value: unknown): 'article' | 'group' {
  return value === 'group' ? 'group' : 'article'
}

function normalizeContentJson(contentJson: string | undefined): string {
  if (!contentJson) return DEFAULT_CONTENT_JSON

  try {
    return serializeEditorContent(parseEditorContentJson(contentJson))
  } catch {
    return DEFAULT_CONTENT_JSON
  }
}
