import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RssEntry, RssSource } from '@/models/inbox/rss'
import { ok } from '@/models/shared/result'
import type { RssRepository } from '@/repositories/inbox/RssRepository'
import { RssService } from '@/services/inbox/RssService'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('RssService', () => {
  beforeEach(() => invoke.mockReset())

  it('validates, fetches and persists a new source with initial entries', async () => {
    const repository = createRepository()
    invoke.mockResolvedValue(fetchResult())
    const service = new RssService(
      repository,
      () => 'rss-source-1',
      () => 10,
    )

    const result = await service.createSource({
      displayName: '',
      feedUrl: 'https://example.com/feed.xml',
      sourceCategory: '技术',
    })

    expect(result).toMatchObject({
      ok: true,
      value: { imported: 1, source: { displayName: 'Example Feed' } },
    })
    expect(invoke).toHaveBeenCalledWith('fetch_rss_feed', {
      input: {
        url: 'https://example.com/feed.xml',
        etag: null,
        lastModified: null,
        afterPublishedAt: null,
        limit: 50,
      },
    })
    expect(repository.upsertEntries).toHaveBeenCalledOnce()
  })

  it('uses conditional validators and handles not-modified without inserting entries', async () => {
    const repository = createRepository()
    invoke.mockResolvedValue({ ...fetchResult(), notModified: true, entries: [], feedTitle: null })
    const source = sourceValue()
    const service = new RssService(
      repository,
      () => 'unused',
      () => 20,
    )

    expect(await service.syncSource(source)).toEqual({ ok: true, value: 0 })
    expect(invoke).toHaveBeenCalledWith('fetch_rss_feed', {
      input: {
        url: source.feedUrl,
        etag: source.etag,
        lastModified: source.lastModified,
        afterPublishedAt: source.syncCursorAt,
        limit: 50,
      },
    })
    expect(repository.upsertEntries).not.toHaveBeenCalled()
    expect(repository.updateSyncState).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ lastSyncedAt: 20, lastError: null }),
    )
  })

  it('refreshes an unchanged feed once to backfill legacy summary-only entries', async () => {
    const repository = createRepository()
    repository.listEntries.mockResolvedValue(ok([entryValue()]))
    invoke.mockResolvedValue(fetchResult())
    const source = sourceValue()
    const service = new RssService(
      repository,
      () => 'unused',
      () => 20,
    )

    expect(await service.syncSource(source)).toEqual({ ok: true, value: 1 })
    expect(invoke).toHaveBeenCalledWith('fetch_rss_feed', {
      input: {
        url: source.feedUrl,
        etag: null,
        lastModified: null,
        afterPublishedAt: null,
        limit: 50,
      },
    })
  })

  it('extracts and persists article-page content for an existing entry', async () => {
    const repository = createRepository()
    const entry = entryValue()
    const updated = { ...entry, bodyText: 'complete article', contentSource: 'article' as const }
    repository.updateArticleContent.mockResolvedValue(ok(updated))
    invoke.mockResolvedValue({
      title: 'Article title',
      author: 'Alice',
      bodyText: 'complete article',
      extractedAt: 30,
    })
    const service = new RssService(repository, () => 'unused')

    expect(await service.extractArticle(entry)).toEqual(ok(updated))
    expect(invoke).toHaveBeenCalledWith('fetch_rss_article', {
      input: { url: entry.articleUrl },
    })
    expect(repository.updateArticleContent).toHaveBeenCalledWith(
      entry.id,
      expect.objectContaining({ bodyText: 'complete article', extractedAt: 30 }),
    )
  })
})

function createRepository() {
  return {
    listSources: vi.fn(async () => ok([])),
    getSource: vi.fn(async () => ok(sourceValue())),
    createSource: vi.fn(async (source) => ok(source)),
    deleteSource: vi.fn(async () => ok(undefined)),
    updateSyncState: vi.fn(async () => ok(sourceValue())),
    upsertEntries: vi.fn(async (_source, entries) => ok(entries.length)),
    listEntries: vi.fn(async () => ok([])),
    setEntryStatus: vi.fn(),
    updateCategory: vi.fn(),
    updateArticleContent: vi.fn(),
  } satisfies RssRepository
}

function sourceValue(): RssSource {
  return {
    id: 'rss-source-1',
    displayName: 'Example Feed',
    feedUrl: 'https://example.com/feed.xml',
    siteUrl: 'https://example.com',
    description: 'Updates',
    sourceCategory: '技术',
    etag: '"v1"',
    lastModified: 'Mon, 27 Jul 2026 12:00:00 GMT',
    enabled: true,
    lastSyncedAt: 10,
    syncCursorAt: 5,
    lastError: null,
    createdAt: 10,
    updatedAt: 10,
  }
}

function fetchResult() {
  return {
    notModified: false,
    effectiveUrl: 'https://example.com/feed.xml',
    feedTitle: 'Example Feed',
    feedDescription: 'Updates',
    siteUrl: 'https://example.com',
    feedType: 'RSS2',
    etag: '"v1"',
    lastModified: null,
    entries: [
      {
        remoteId: 'hash-1',
        articleUrl: 'https://example.com/post',
        title: 'Hello',
        author: 'Alice',
        publishedAt: 1,
        updatedAt: null,
        preview: 'hello',
        bodyText: 'hello reader',
        contentSource: 'summary' as const,
        articleFetchedAt: null,
        articleFetchError: null,
        categories: ['News'],
      },
    ],
  }
}

function entryValue(): RssEntry {
  return {
    id: 'entry-1',
    sourceId: 'rss-source-1',
    remoteId: 'remote-1',
    articleUrl: 'https://example.com/post',
    title: 'Post',
    author: 'Alice',
    publishedAt: 1,
    updatedAt: null,
    preview: 'summary',
    bodyText: 'summary',
    contentSource: 'summary',
    articleFetchedAt: null,
    articleFetchError: null,
    categories: [],
    processingStatus: 'pending',
    syncedAt: 1,
  }
}
