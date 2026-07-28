import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RssSource } from '@/models/inbox/rss'
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
    })

    expect(result).toMatchObject({
      ok: true,
      value: { imported: 1, source: { displayName: 'Example Feed' } },
    })
    expect(invoke).toHaveBeenCalledWith('fetch_rss_feed', {
      input: { url: 'https://example.com/feed.xml', etag: null, lastModified: null, limit: 50 },
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
        limit: 50,
      },
    })
    expect(repository.upsertEntries).not.toHaveBeenCalled()
    expect(repository.updateSyncState).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ lastSyncedAt: 20, lastError: null }),
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
  } satisfies RssRepository
}

function sourceValue(): RssSource {
  return {
    id: 'rss-source-1',
    displayName: 'Example Feed',
    feedUrl: 'https://example.com/feed.xml',
    siteUrl: 'https://example.com',
    description: 'Updates',
    etag: '"v1"',
    lastModified: 'Mon, 27 Jul 2026 12:00:00 GMT',
    enabled: true,
    lastSyncedAt: 10,
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
        categories: ['News'],
      },
    ],
  }
}
