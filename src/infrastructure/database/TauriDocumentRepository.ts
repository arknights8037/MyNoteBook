import { invoke } from '@tauri-apps/api/core'

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
import type { DocumentBlock } from '@/models/documentBlock'
import { err, normalizeError, ok, type AppResult } from '@/models/result'
import type { DocumentRepository } from '@/repositories/DocumentRepository'
import type { SqlClient } from '@/repositories/SqlClient'
import { parseEditorContentJson, serializeEditorContent } from '@/editor/editorContent'
import { loadAppSettings } from '@/models/settings'

interface DocumentRow extends Record<string, unknown> {
  id: string
  parent_id: string | null
  document_kind?: string
  title: string
  source_url?: string
  author?: string
  description?: string
  content_json: string
  plain_text?: string
  character_count?: number
  schema_version: number
  revision: number
  sort_order: number
  is_deleted: number
  created_at: number
  updated_at: number
}

interface DocumentTagRow extends Record<string, unknown> {
  document_id: string
  name: string
}

const DOCUMENT_SUMMARY_COLUMNS = `
  id, parent_id, document_kind, title, source_url, author, description,
  length(trim(plain_text)) AS character_count,
  revision, sort_order, is_deleted, created_at, updated_at
`
const QUALIFIED_DOCUMENT_SUMMARY_COLUMNS = `
  documents.id, documents.parent_id, documents.document_kind, documents.title,
  documents.source_url, documents.author, documents.description, documents.plain_text,
  length(trim(documents.plain_text)) AS character_count,
  documents.revision, documents.sort_order, documents.is_deleted,
  documents.created_at, documents.updated_at
`

const DEFAULT_CONTENT_JSON = serializeEditorContent(EMPTY_TIPTAP_DOCUMENT)

export class TauriDocumentRepository implements DocumentRepository {
  constructor(
    private readonly sqlClient: SqlClient,
    private readonly persistCore: (
      document: DocumentRecord,
      expectedRevision: number | null,
    ) => Promise<void> = persistDocumentThroughTauri,
  ) {}

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

    return this.persistThroughDocumentCore(document, null, 'Failed to create document.')
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
        `SELECT ${DOCUMENT_SUMMARY_COLUMNS}
         FROM documents
         WHERE ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'}
           ${options.includeDeleted ? '' : 'AND is_deleted = 0'}
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
        parentId === null ? [] : [parentId],
      )

      return ok(await this.mapDocumentSummaryRows(rows))
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
        `SELECT ${DOCUMENT_SUMMARY_COLUMNS}
         FROM documents
         WHERE ${options.includeDeleted ? '1 = 1' : 'is_deleted = 0'}
         ORDER BY sort_order ASC, created_at ASC, id ASC
         LIMIT ?`,
        [limit],
      )

      return ok(await this.mapDocumentSummaryRows(rows))
    } catch (error) {
      return err(normalizeError(error, 'Failed to list recent documents.'))
    }
  }

  async listDeleted(options: { limit?: number } = {}): Promise<AppResult<DocumentSummary[]>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))

    try {
      const rows = await this.sqlClient.select<DocumentRow>(
        `SELECT ${DOCUMENT_SUMMARY_COLUMNS}
         FROM documents
         WHERE is_deleted = 1
         ORDER BY updated_at DESC
         LIMIT ?`,
        [limit],
      )

      return ok(await this.mapDocumentSummaryRows(rows))
    } catch (error) {
      return err(normalizeError(error, 'Failed to list deleted documents.'))
    }
  }

  async searchKnowledge(
    query: string,
    options: { limit?: number } = {},
  ): Promise<AppResult<DocumentSummary[]>> {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return ok([])
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20))

    try {
      const rows = await this.sqlClient.select<DocumentRow>(
        `SELECT ${QUALIFIED_DOCUMENT_SUMMARY_COLUMNS}
         FROM document_search
         INNER JOIN documents ON documents.id = document_search.document_id
         WHERE document_search MATCH ?
           AND documents.document_kind = 'article'
           AND documents.is_deleted = 0
         ORDER BY bm25(document_search), documents.updated_at DESC
         LIMIT ?`,
        [ftsQuery, limit],
      )
      return ok(await this.mapDocumentSummaryRows(rows))
    } catch (error) {
      return err(normalizeError(error, 'Failed to search knowledge documents.'))
    }
  }

  async listBlocks(documentId: DocumentId): Promise<AppResult<DocumentBlock[]>> {
    try {
      const rows = await this.sqlClient.select<{
        document_id: string
        id: string
        block_type: string
        block_index: number
        content_json: string
        plain_text: string
        document_revision: number
        updated_at: number
      }>(
        `SELECT document_id, id, block_type, block_index, content_json, plain_text,
                document_revision, updated_at
         FROM blocks
         WHERE document_id = ?
         ORDER BY block_index ASC`,
        [documentId],
      )
      return ok(
        rows.map((row) => ({
          id: row.id,
          documentId: row.document_id,
          type: row.block_type,
          index: row.block_index,
          contentJson: row.content_json,
          plainText: row.plain_text,
          documentRevision: row.document_revision,
          updatedAt: row.updated_at,
        })),
      )
    } catch (error) {
      return err(normalizeError(error, 'Failed to list document blocks.'))
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
      contentJson:
        input.contentJson === undefined
          ? existing.contentJson
          : normalizeContentJson(input.contentJson),
      plainText: input.plainText ?? existing.plainText,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      revision: existing.revision + 1,
      updatedAt: Date.now(),
    }

    return this.persistExistingDocument(nextDocument, input.expectedRevision)
  }

  async save(input: SaveDocumentInput): Promise<AppResult<DocumentRecord>> {
    const now = Date.now()
    const existingResult =
      input.expectedRevision === null ? null : await this.findById(input.id)
    if (existingResult && !existingResult.ok) return existingResult
    const existing = existingResult?.value
    return this.persistThroughDocumentCore(
      {
        id: input.id,
        parentId: input.parentId ?? null,
        documentKind: input.documentKind ?? 'article',
        title: input.title,
        tags: normalizeTags(input.tags ?? existing?.tags),
        sourceUrl: input.sourceUrl ?? '',
        author: input.author ?? '',
        description: input.description ?? '',
        contentJson: normalizeContentJson(input.contentJson),
        plainText: input.plainText,
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        revision: input.expectedRevision ?? 0,
        sortOrder: input.sortOrder ?? 0,
        isDeleted: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
      input.expectedRevision,
      'Failed to save document.',
    )
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
    return this.persistThroughDocumentCore(
      document,
      expectedRevision,
      'Failed to persist document.',
    )
  }

  private async persistThroughDocumentCore(
    document: DocumentRecord,
    expectedRevision: number | null,
    fallbackMessage: string,
  ): Promise<AppResult<DocumentRecord>> {
    try {
      await this.persistCore(document, expectedRevision)
      return this.findById(document.id, { includeDeleted: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/revision|版本冲突|版本.*变化/i.test(message)) {
        return err({ code: 'revision-conflict', message, cause: error })
      }
      return err(normalizeError(error, fallbackMessage))
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

  private async mapDocumentSummaryRows(rows: DocumentRow[]): Promise<DocumentSummary[]> {
    if (rows.length === 0) return []

    const tagsByDocumentId = await this.listDocumentTagsBatch(rows.map((row) => row.id))
    return rows.map((row) => ({
      ...mapDocumentBase(row),
      tags: tagsByDocumentId.get(row.id) ?? [],
      characterCount: row.character_count ?? Array.from((row.plain_text ?? '').trim()).length,
    }))
  }

  private async listDocumentTagsBatch(
    documentIds: DocumentId[],
  ): Promise<Map<DocumentId, string[]>> {
    const placeholders = documentIds.map(() => '?').join(', ')
    const rows = await this.sqlClient.select<DocumentTagRow>(
      `SELECT document_tags.document_id, tags.name
       FROM document_tags
       INNER JOIN tags ON tags.id = document_tags.tag_id
       WHERE document_tags.document_id IN (${placeholders})
       ORDER BY document_tags.document_id ASC, tags.name COLLATE NOCASE ASC`,
      documentIds,
    )
    const tagsByDocumentId = new Map<DocumentId, string[]>()
    for (const row of rows) {
      const tags = tagsByDocumentId.get(row.document_id) ?? []
      tags.push(row.name)
      tagsByDocumentId.set(row.document_id, tags)
    }
    return tagsByDocumentId
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

}

async function persistDocumentThroughTauri(
  document: DocumentRecord,
  expectedRevision: number | null,
): Promise<void> {
  await invoke('persist_document', {
    input: {
      dataDirectory: loadAppSettings().dataDirectory,
      id: document.id,
      expectedRevision,
      parentId: document.parentId,
      documentKind: document.documentKind,
      title: document.title,
      tags: normalizeTags(document.tags),
      sourceUrl: document.sourceUrl,
      author: document.author,
      description: document.description,
      contentJson: normalizeContentJson(document.contentJson),
      sortOrder: document.sortOrder,
      isDeleted: document.isDeleted,
      updatedAt: document.updatedAt,
    },
  })
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
    plainText: row.plain_text ?? '',
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

function buildFtsQuery(query: string): string {
  const terms = query
    .replace(/["']/g, ' ')
    .match(/[\p{L}\p{N}_-]{2,}/gu)
    ?.slice(0, 12)
    .map((term) => `"${term}"`)
  return terms?.join(' OR ') ?? ''
}
