import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TauriDocumentRepository } from './TauriDocumentRepository'
import { DOCUMENT_SCHEMA_VERSION, type DocumentRecord } from '@/models/document'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/SqlClient'

class MemorySqlClient implements SqlClient {
  readonly documents = new Map<string, DocumentRecord>()
  readonly tags = new Map<string, string>()
  readonly documentTags = new Map<string, Set<string>>()
  batchTagQueryCount = 0
  documentTagDeleteCount = 0
  readonly selectedSql: string[] = []

  async persistCore(document: DocumentRecord, expectedRevision: number | null): Promise<void> {
    const existing = this.documents.get(document.id)
    if ((existing?.revision ?? null) !== expectedRevision) {
      throw new Error('文档版本冲突')
    }
    const previousTags = existing?.tags ?? []
    const nextTags = [...document.tags].sort((left, right) => left.localeCompare(right))
    if (previousTags.join('\0') !== nextTags.join('\0')) {
      this.documentTagDeleteCount += 1
      const tagIds = new Set<string>()
      for (const tag of nextTags) {
        const existingTag = [...this.tags.entries()].find(([, value]) => value === tag)
        const tagId = existingTag?.[0] ?? `tag-${this.tags.size + 1}`
        this.tags.set(tagId, tag)
        tagIds.add(tagId)
      }
      this.documentTags.set(document.id, tagIds)
    }
    this.documents.set(document.id, {
      ...document,
      tags: nextTags,
      revision: existing ? existing.revision + 1 : 1,
      createdAt: existing?.createdAt ?? document.createdAt,
    })
  }

  async execute(sql: string, bindValues: SqlValue[] = []): Promise<SqlExecuteResult> {
    const normalizedSql = normalizeSql(sql)

    if (normalizedSql.startsWith('insert into documents')) {
      if (normalizedSql.includes('on conflict')) {
        const [
          id,
          parentId,
          documentKind,
          title,
          sourceUrl,
          author,
          description,
          contentJson,
          plainText,
          schemaVersion,
          insertRevision,
          sortOrder,
          createdAt,
          updatedAt,
          expectedRevision,
        ] = bindValues

        const existing = this.documents.get(String(id))
        if (existing && existing.revision !== Number(expectedRevision)) {
          return { rowsAffected: 0 }
        }

        this.documents.set(String(id), {
          id: String(id),
          parentId: parentId === null ? null : String(parentId),
          documentKind: documentKind === 'group' ? 'group' : 'article',
          title: String(title),
          tags: this.getDocumentTags(String(id)),
          sourceUrl: String(sourceUrl),
          author: String(author),
          description: String(description),
          contentJson: String(contentJson),
          plainText: String(plainText),
          schemaVersion: Number(schemaVersion),
          revision: existing ? existing.revision + 1 : Number(insertRevision),
          sortOrder: Number(sortOrder),
          isDeleted: false,
          createdAt: existing ? existing.createdAt : Number(createdAt),
          updatedAt: Number(updatedAt),
        })

        return { rowsAffected: 1 }
      }

      const [
        id,
        parentId,
        documentKind,
        title,
        sourceUrl,
        author,
        description,
        contentJson,
        plainText,
        schemaVersion,
        revision,
        sortOrder,
        isDeleted,
        createdAt,
        updatedAt,
      ] = bindValues

      this.documents.set(String(id), {
        id: String(id),
        parentId: parentId === null ? null : String(parentId),
        documentKind: documentKind === 'group' ? 'group' : 'article',
        title: String(title),
        tags: this.getDocumentTags(String(id)),
        sourceUrl: String(sourceUrl),
        author: String(author),
        description: String(description),
        contentJson: String(contentJson),
        plainText: String(plainText),
        schemaVersion: Number(schemaVersion),
        revision: Number(revision),
        sortOrder: Number(sortOrder),
        isDeleted: Number(isDeleted) === 1,
        createdAt: Number(createdAt),
        updatedAt: Number(updatedAt),
      })

      return { rowsAffected: 1 }
    }

    if (normalizedSql.startsWith('update documents')) {
      const [
        parentId,
        documentKind,
        title,
        sourceUrl,
        author,
        description,
        contentJson,
        plainText,
        schemaVersion,
        revision,
        sortOrder,
        isDeleted,
        updatedAt,
        id,
        expectedRevision,
      ] = bindValues

      const existing = this.documents.get(String(id))
      if (!existing || existing.revision !== Number(expectedRevision)) {
        return { rowsAffected: 0 }
      }

      this.documents.set(String(id), {
        ...existing,
        parentId: parentId === null ? null : String(parentId),
        documentKind: documentKind === 'group' ? 'group' : 'article',
        title: String(title),
        sourceUrl: String(sourceUrl),
        author: String(author),
        description: String(description),
        contentJson: String(contentJson),
        plainText: String(plainText),
        schemaVersion: Number(schemaVersion),
        revision: Number(revision),
        sortOrder: Number(sortOrder),
        isDeleted: Number(isDeleted) === 1,
        updatedAt: Number(updatedAt),
      })

      return { rowsAffected: 1 }
    }

    if (normalizedSql.startsWith('delete from document_tags')) {
      const [documentId] = bindValues
      this.documentTagDeleteCount += 1
      this.documentTags.delete(String(documentId))
      return { rowsAffected: 1 }
    }

    if (normalizedSql.startsWith('insert into tags')) {
      const [tagId, name] = bindValues
      if (![...this.tags.values()].includes(String(name))) {
        this.tags.set(String(tagId), String(name))
      }
      return { rowsAffected: 1 }
    }

    if (normalizedSql.startsWith('insert or ignore into document_tags')) {
      const [documentId, tagId] = bindValues
      const set = this.documentTags.get(String(documentId)) ?? new Set<string>()
      set.add(String(tagId))
      this.documentTags.set(String(documentId), set)
      return { rowsAffected: 1 }
    }

    if (normalizedSql.startsWith('delete from documents')) {
      const [id, expectedRevision] = bindValues
      const existing = this.documents.get(String(id))
      if (!existing || existing.revision !== Number(expectedRevision) || !existing.isDeleted) {
        return { rowsAffected: 0 }
      }

      this.documents.delete(String(id))
      return { rowsAffected: 1 }
    }

    throw new Error(`Unsupported execute SQL in test: ${sql}`)
  }

  async select<T extends Record<string, unknown>>(
    sql: string,
    bindValues: SqlValue[] = [],
  ): Promise<T[]> {
    const normalizedSql = normalizeSql(sql)
    this.selectedSql.push(normalizedSql)
    const rows = [...this.documents.values()]

    if (normalizedSql.includes('where id = ?')) {
      const id = String(bindValues[0])
      const document = this.documents.get(id)
      if (!document) {
        return []
      }
      if (normalizedSql.includes('and is_deleted = 0') && document.isDeleted) {
        return []
      }
      return [toRow(document) as T]
    }

    if (normalizedSql.includes('from tags') && normalizedSql.includes('inner join document_tags')) {
      const documentId = String(bindValues[0])
      return this.getDocumentTags(documentId).map((name) => ({ name }) as T)
    }

    if (
      normalizedSql.includes('select document_tags.document_id, tags.name') &&
      normalizedSql.includes('where document_tags.document_id in')
    ) {
      this.batchTagQueryCount += 1
      return bindValues.flatMap((documentId) =>
        this.getDocumentTags(String(documentId)).map(
          (name) => ({ document_id: String(documentId), name }) as T,
        ),
      )
    }

    if (normalizedSql.includes('select id from tags where name = ?')) {
      const name = String(bindValues[0])
      const row = [...this.tags.entries()].find(([, tagName]) => tagName === name)
      return row ? ([{ id: row[0] }] as T[]) : []
    }

    if (normalizedSql.includes('parent_id is null')) {
      return rows
        .filter((document) => document.parentId === null)
        .filter((document) => !normalizedSql.includes('and is_deleted = 0') || !document.isDeleted)
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder ||
            left.createdAt - right.createdAt ||
            left.id.localeCompare(right.id),
        )
        .map((document) => this.projectDocumentRow(document, normalizedSql) as T)
    }

    if (normalizedSql.includes('parent_id = ?')) {
      const parentId = String(bindValues[0])
      return rows
        .filter((document) => document.parentId === parentId)
        .filter((document) => !normalizedSql.includes('and is_deleted = 0') || !document.isDeleted)
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder ||
            left.createdAt - right.createdAt ||
            left.id.localeCompare(right.id),
        )
        .map((document) => this.projectDocumentRow(document, normalizedSql) as T)
    }

    if (normalizedSql.includes('order by sort_order asc, created_at asc, id asc')) {
      const limit = Number(bindValues[0])
      return rows
        .filter((document) => !normalizedSql.includes('is_deleted = 0') || !document.isDeleted)
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder ||
            left.createdAt - right.createdAt ||
            left.id.localeCompare(right.id),
        )
        .slice(0, limit)
        .map((document) => this.projectDocumentRow(document, normalizedSql) as T)
    }

    if (normalizedSql.includes('order by updated_at desc')) {
      const limit = Number(bindValues[0])
      return rows
        .filter((document) => {
          if (normalizedSql.includes('is_deleted = 1')) {
            return document.isDeleted
          }

          return !normalizedSql.includes('is_deleted = 0') || !document.isDeleted
        })
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit)
        .map((document) => this.projectDocumentRow(document, normalizedSql) as T)
    }

    throw new Error(`Unsupported select SQL in test: ${sql}`)
  }

  // FTS is covered by the real SQLite migration; this in-memory document repository fake only
  // exercises the CRUD contract used by the existing tests.
  async searchKnowledge(): Promise<never> {
    throw new Error('Not implemented in MemorySqlClient')
  }

  private getDocumentTags(documentId: string): string[] {
    const tagIds = this.documentTags.get(documentId) ?? new Set<string>()
    return [...tagIds]
      .map((tagId) => this.tags.get(tagId))
      .filter((tag): tag is string => Boolean(tag))
      .sort((left, right) => left.localeCompare(right))
  }

  private projectDocumentRow(
    document: DocumentRecord,
    normalizedSql: string,
  ): Record<string, unknown> {
    const row = toRow(document)
    if (
      normalizedSql.includes('length(trim(plain_text)) as character_count') &&
      !normalizedSql.includes('documents.plain_text')
    ) {
      row.plain_text = undefined
      row.character_count = Array.from(document.plainText.trim()).length
    }
    return row
  }
}

describe('TauriDocumentRepository', () => {
  let sqlClient: MemorySqlClient
  let repository: TauriDocumentRepository

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'))
    sqlClient = new MemorySqlClient()
    repository = new TauriDocumentRepository(sqlClient, (document, expectedRevision) =>
      sqlClient.persistCore(document, expectedRevision),
    )
  })

  it('creates and reads a document', async () => {
    const created = await repository.create({
      id: 'doc-1',
      title: '第一篇笔记',
      plainText: 'hello',
    })

    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.revision).toBe(1)

    const found = await repository.findById('doc-1')

    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.title).toBe('第一篇笔记')
    expect(found.value.tags).toEqual([])
    expect(found.value.isDeleted).toBe(false)
  })

  it('updates with optimistic revision control', async () => {
    await repository.create({ id: 'doc-1', title: 'Draft' })

    const updated = await repository.update({
      id: 'doc-1',
      expectedRevision: 1,
      title: 'Published',
    })

    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.title).toBe('Published')
    expect(updated.value.revision).toBe(2)

    const staleUpdate = await repository.update({
      id: 'doc-1',
      expectedRevision: 1,
      title: 'Stale write',
    })

    expect(staleUpdate.ok).toBe(false)
    if (staleUpdate.ok) return
    expect(staleUpdate.error.code).toBe('revision-conflict')
  })

  it('does not rewrite tag relations when an update leaves tags unchanged', async () => {
    await repository.create({ id: 'doc-1', title: 'Draft', tags: ['database'] })
    const tagDeletesAfterCreate = sqlClient.documentTagDeleteCount

    const updated = await repository.update({
      id: 'doc-1',
      expectedRevision: 1,
      title: 'Published',
    })

    expect(updated.ok).toBe(true)
    expect(sqlClient.documentTagDeleteCount).toBe(tagDeletesAfterCreate)
    if (!updated.ok) return
    expect(updated.value.tags).toEqual(['database'])
  })

  it('rewrites tag relations when tags are explicitly updated', async () => {
    await repository.create({ id: 'doc-1', title: 'Draft', tags: ['old'] })
    const tagDeletesAfterCreate = sqlClient.documentTagDeleteCount

    const updated = await repository.update({
      id: 'doc-1',
      expectedRevision: 1,
      tags: ['new'],
    })

    expect(updated.ok).toBe(true)
    expect(sqlClient.documentTagDeleteCount).toBe(tagDeletesAfterCreate + 1)
    if (!updated.ok) return
    expect(updated.value.tags).toEqual(['new'])
  })

  it('saves with SQLite-style upsert and revision control', async () => {
    const inserted = await repository.save({
      id: 'doc-1',
      expectedRevision: null,
      title: 'Draft',
      contentJson: '{"type":"doc"}',
      plainText: 'Draft',
    })

    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    expect(inserted.value.revision).toBe(1)

    const saved = await repository.save({
      id: 'doc-1',
      expectedRevision: 1,
      title: 'Saved',
      contentJson: '{"type":"doc"}',
      plainText: 'Saved',
    })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.revision).toBe(2)
    expect(saved.value.title).toBe('Saved')

    const staleSave = await repository.save({
      id: 'doc-1',
      expectedRevision: 1,
      title: 'Stale',
      contentJson: '{"type":"doc"}',
      plainText: 'Stale',
    })

    expect(staleSave.ok).toBe(false)
    if (staleSave.ok) return
    expect(staleSave.error.code).toBe('revision-conflict')
  })

  it('does not rewrite unchanged tags during autosave', async () => {
    const inserted = await repository.save({
      id: 'doc-1',
      expectedRevision: null,
      title: 'Draft',
      tags: ['database', 'performance'],
      contentJson: '{"type":"doc"}',
      plainText: 'Draft',
    })
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    const tagDeletesAfterInsert = sqlClient.documentTagDeleteCount

    const saved = await repository.save({
      id: 'doc-1',
      expectedRevision: inserted.value.revision,
      title: 'Draft',
      tags: ['performance', 'database'],
      contentJson: '{"type":"doc"}',
      plainText: 'Updated body',
    })

    expect(saved.ok).toBe(true)
    expect(sqlClient.documentTagDeleteCount).toBe(tagDeletesAfterInsert)
  })

  it('lazily migrates legacy block ids on save and keeps ids stable after read', async () => {
    const legacyParagraphId = 'cb5114f8-0c97-4b7b-ad69-c6c14b44072f'
    const inserted = await repository.save({
      id: 'doc-1',
      expectedRevision: null,
      title: 'Legacy',
      contentJson: JSON.stringify({
        type: 'doc',
        schemaVersion: 1,
        content: [
          {
            type: 'paragraph',
            attrs: { blockId: `paragraph-${legacyParagraphId}`, indentLevel: 1 },
          },
        ],
      }),
      plainText: 'Legacy',
    })

    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return

    const migrated = JSON.parse(inserted.value.contentJson) as {
      attrs?: { id?: string }
      content?: Array<{ attrs?: Record<string, unknown> }>
      schemaVersion?: number
    }
    const docId = migrated.attrs?.id
    const paragraphAttrs = migrated.content?.[0]?.attrs

    expect(inserted.value.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION)
    expect(migrated.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION)
    expect(docId).toEqual(expect.stringMatching(uuidRegex()))
    expect(paragraphAttrs?.id).toBe(legacyParagraphId)
    expect(paragraphAttrs?.blockId).toBeUndefined()
    expect(paragraphAttrs?.indentLevel).toBe(1)

    const savedAgain = await repository.save({
      id: 'doc-1',
      expectedRevision: inserted.value.revision,
      title: 'Legacy',
      contentJson: inserted.value.contentJson,
      plainText: 'Legacy',
    })

    expect(savedAgain.ok).toBe(true)
    if (!savedAgain.ok) return

    const readBack = JSON.parse(savedAgain.value.contentJson) as {
      attrs?: { id?: string }
      content?: Array<{ attrs?: Record<string, unknown> }>
    }
    expect(readBack.attrs?.id).toBe(docId)
    expect(readBack.content?.[0]?.attrs?.id).toBe(legacyParagraphId)
  })

  it('soft deletes and restores a document', async () => {
    await repository.create({ id: 'doc-1', title: 'Trash me' })

    const deleted = await repository.softDelete('doc-1', 1)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.isDeleted).toBe(true)

    const hidden = await repository.findById('doc-1')
    expect(hidden.ok).toBe(false)
    if (hidden.ok) return
    expect(hidden.error.code).toBe('not-found')

    const restored = await repository.restore('doc-1', 2)
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.value.isDeleted).toBe(false)
  })

  it('permanently deletes a document from trash', async () => {
    await repository.create({ id: 'doc-1', title: 'Trash me' })
    await repository.softDelete('doc-1', 1)

    const deleted = await repository.hardDelete('doc-1', 2)

    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.id).toBe('doc-1')

    const found = await repository.findById('doc-1', { includeDeleted: true })
    expect(found.ok).toBe(false)
  })

  it('rejects permanent deletion for active documents', async () => {
    await repository.create({ id: 'doc-1', title: 'Keep me' })

    const deleted = await repository.hardDelete('doc-1', 1)

    expect(deleted.ok).toBe(false)
    if (deleted.ok) return
    expect(deleted.error.code).toBe('validation-error')
  })

  it('lists active root documents by sort order', async () => {
    await repository.create({ id: 'doc-2', title: 'Second', sortOrder: 2 })
    await repository.create({ id: 'doc-1', title: 'First', sortOrder: 1 })
    await repository.softDelete('doc-2', 1)

    const roots = await repository.listByParent(null)

    expect(roots.ok).toBe(true)
    if (!roots.ok) return
    expect(roots.value.map((document) => document.id)).toEqual(['doc-1'])
    expect(roots.value[0]?.createdAt).toBe(Date.now())
    expect(roots.value[0]?.plainText).toBe('')
    expect(roots.value[0]?.characterCount).toBe(0)
    expect(sqlClient.batchTagQueryCount).toBe(1)
  })

  it('keeps full document bodies out of list queries', async () => {
    await repository.create({ id: 'doc-1', title: 'Large note', plainText: '正文'.repeat(10_000) })

    const documents = await repository.listRecent({ limit: 200 })

    expect(documents.ok).toBe(true)
    if (!documents.ok) return
    expect(documents.value[0]?.plainText).toBe('')
    expect(documents.value[0]?.characterCount).toBe(20_000)
    const listQuery = sqlClient.selectedSql.find((sql) =>
      sql.includes('order by sort_order asc, created_at asc, id asc'),
    )
    expect(listQuery).toContain('length(trim(plain_text)) as character_count')
    expect(listQuery).not.toContain('description, plain_text, revision')
  })

  it('lists active documents in a stable position after updates', async () => {
    await repository.create({ id: 'first', title: 'First', sortOrder: 1 })
    vi.setSystemTime(new Date('2026-06-21T00:00:01.000Z'))
    await repository.create({ id: 'second', title: 'Second', sortOrder: 2 })
    vi.setSystemTime(new Date('2026-06-21T00:00:02.000Z'))
    await repository.update({ id: 'first', expectedRevision: 1, title: 'First updated' })

    const documents = await repository.listRecent({ limit: 200 })

    expect(documents.ok).toBe(true)
    if (!documents.ok) return
    expect(documents.value.map((document) => document.id)).toEqual(['first', 'second'])
  })

  it('lists deleted documents separately', async () => {
    await repository.create({ id: 'doc-1', title: 'Active' })
    await repository.create({ id: 'doc-2', title: 'Deleted' })
    await repository.softDelete('doc-2', 1)

    const deleted = await repository.listDeleted()

    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.map((document) => document.id)).toEqual(['doc-2'])
  })
})

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

function toRow(document: DocumentRecord): Record<string, unknown> {
  return {
    id: document.id,
    parent_id: document.parentId,
    title: document.title,
    document_kind: document.documentKind,
    source_url: document.sourceUrl,
    author: document.author,
    description: document.description,
    content_json: document.contentJson,
    plain_text: document.plainText,
    schema_version: document.schemaVersion,
    revision: document.revision,
    sort_order: document.sortOrder,
    is_deleted: document.isDeleted ? 1 : 0,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  }
}

function uuidRegex(): RegExp {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
}
