import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { TauriRssRepository } from '@/infrastructure/database/inbox/TauriRssRepository'
import type { RssSource } from '@/models/inbox/rss'
import type { SqlClient, SqlExecuteResult, SqlValue } from '@/repositories/shared/SqlClient'

class Client implements SqlClient {
  database = new DatabaseSync(':memory:')
  async execute(sql: string, values: SqlValue[] = []): Promise<SqlExecuteResult> {
    const result = this.database.prepare(sql).run(...values.map(normalizeValue))
    return { rowsAffected: Number(result.changes) }
  }
  async select<T extends Record<string, unknown>>(
    sql: string,
    values: SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...values.map(normalizeValue)) as T[]
  }
}

describe('TauriRssRepository', () => {
  it('deduplicates entries, preserves local status, stores validators, and cascades deletion', async () => {
    const client = new Client()
    client.database.exec(
      readFileSync(join(process.cwd(), 'src-tauri/migrations/0031_add_rss_inbox.sql'), 'utf8'),
    )
    client.database.exec(
      readFileSync(
        join(process.cwd(), 'src-tauri/migrations/0032_add_rss_article_extraction.sql'),
        'utf8',
      ),
    )
    const repository = new TauriRssRepository(client)
    const source: RssSource = {
      id: 'rss-source-1',
      displayName: 'Example',
      feedUrl: 'https://example.com/feed.xml',
      siteUrl: 'https://example.com',
      description: 'Updates',
      etag: '"v1"',
      lastModified: null,
      enabled: true,
      lastSyncedAt: 1,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(await repository.createSource(source)).toMatchObject({
      ok: true,
      value: { id: source.id },
    })
    const remote = {
      remoteId: 'hash-1',
      articleUrl: 'https://example.com/post',
      title: 'First',
      author: 'Alice',
      publishedAt: 2,
      updatedAt: null,
      preview: 'hello',
      bodyText: 'hello reader',
      contentSource: 'summary' as const,
      articleFetchedAt: null,
      articleFetchError: null,
      categories: ['News'],
    }
    expect(await repository.upsertEntries(source, [remote], 3)).toEqual({ ok: true, value: 1 })
    const first = await repository.listEntries()
    if (!first.ok) throw new Error('expected RSS entries')
    await repository.setEntryStatus(first.value[0]!.id, 'done')
    await repository.upsertEntries(source, [{ ...remote, title: 'Updated' }], 4)
    expect(await repository.listEntries()).toMatchObject({
      ok: true,
      value: [{ title: 'Updated', categories: ['News'], processingStatus: 'done' }],
    })
    const listed = await repository.listEntries()
    if (!listed.ok) throw new Error('expected RSS entries')
    await repository.updateArticleContent(listed.value[0]!.id, {
      title: 'Article title',
      author: 'Article author',
      bodyText: 'complete article body',
      extractedAt: 6,
    })
    await repository.upsertEntries(source, [{ ...remote, bodyText: 'short summary' }], 7)
    expect(await repository.listEntries()).toMatchObject({
      ok: true,
      value: [
        {
          bodyText: 'complete article body',
          contentSource: 'article',
          articleFetchedAt: 6,
        },
      ],
    })
    expect(
      await repository.updateSyncState(source.id, {
        etag: '"v2"',
        lastModified: 'Tue, 28 Jul 2026 12:00:00 GMT',
        lastSyncedAt: 5,
        lastError: null,
        updatedAt: 5,
      }),
    ).toMatchObject({ ok: true, value: { etag: '"v2"', lastSyncedAt: 5 } })
    await repository.deleteSource(source.id)
    expect(await repository.listEntries()).toEqual({ ok: true, value: [] })
  })
})

function normalizeValue(value: SqlValue) {
  return typeof value === 'boolean' ? Number(value) : value
}
