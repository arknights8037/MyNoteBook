import { invoke } from '@tauri-apps/api/core'

import {
  validateRssSourceInput,
  type CreateRssSourceInput,
  type RssArticleFetchResult,
  type RssEntry,
  type RssFetchResult,
  type RssProcessingStatus,
  type RssSource,
} from '@/models/inbox/rss'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { RssRepository } from '@/repositories/inbox/RssRepository'

export class RssService {
  constructor(
    private readonly repository: RssRepository,
    private readonly createId: (prefix: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  listSources() {
    return this.repository.listSources()
  }

  listEntries(input: { sourceId?: string; status?: RssProcessingStatus; limit?: number } = {}) {
    return this.repository.listEntries(input)
  }

  async createSource(
    input: CreateRssSourceInput,
  ): Promise<AppResult<{ source: RssSource; imported: number }>> {
    const invalid = validateRssSourceInput(input)
    if (invalid) return err({ code: 'validation-error', message: invalid })
    let fetched: RssFetchResult
    try {
      fetched = await this.fetch(input.feedUrl, null, null, 50)
    } catch (error) {
      return err(normalizeError(error, '无法读取 RSS 订阅源。'))
    }
    const createdAt = this.now()
    const source: RssSource = {
      id: this.createId('rss-source'),
      displayName:
        input.displayName.trim() || fetched.feedTitle?.trim() || new URL(input.feedUrl).hostname,
      feedUrl: input.feedUrl.trim(),
      siteUrl: fetched.siteUrl,
      description: fetched.feedDescription ?? '',
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      enabled: true,
      lastSyncedAt: createdAt,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    }
    const created = await this.repository.createSource(source)
    if (!created.ok) return created
    const stored = await this.repository.upsertEntries(created.value, fetched.entries, createdAt)
    if (!stored.ok) {
      await this.repository.updateSyncState(source.id, {
        lastSyncedAt: null,
        lastError: stored.error.message,
        updatedAt: createdAt,
      })
      return stored
    }
    return ok({ source: created.value, imported: stored.value })
  }

  async syncSource(source: RssSource, limit = 50): Promise<AppResult<number>> {
    const syncedAt = this.now()
    try {
      const localEntries = await this.repository.listEntries({ sourceId: source.id, limit: 12 })
      const needsArticleBackfill =
        localEntries.ok &&
        localEntries.value.some(
          (entry) =>
            entry.contentSource === 'summary' &&
            Boolean(entry.articleUrl) &&
            entry.articleFetchedAt == null &&
            !entry.articleFetchError,
        )
      const fetched = await this.fetch(
        source.feedUrl,
        needsArticleBackfill ? null : source.etag,
        needsArticleBackfill ? null : source.lastModified,
        limit,
      )
      const stored = fetched.notModified
        ? ok(0)
        : await this.repository.upsertEntries(source, fetched.entries, syncedAt)
      if (!stored.ok) {
        await this.repository.updateSyncState(source.id, {
          lastSyncedAt: source.lastSyncedAt,
          lastError: stored.error.message,
          updatedAt: syncedAt,
        })
        return stored
      }
      const updated = await this.repository.updateSyncState(source.id, {
        siteUrl: fetched.siteUrl,
        description: fetched.feedDescription,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        lastSyncedAt: syncedAt,
        lastError: null,
        updatedAt: syncedAt,
      })
      if (!updated.ok) return err(updated.error)
      return stored
    } catch (error) {
      const normalized = normalizeError(error, 'RSS 同步失败。')
      await this.repository.updateSyncState(source.id, {
        lastSyncedAt: source.lastSyncedAt,
        lastError: normalized.message,
        updatedAt: syncedAt,
      })
      return err(normalized)
    }
  }

  async deleteSource(id: string): Promise<AppResult<void>> {
    return this.repository.deleteSource(id)
  }

  setEntryStatus(id: string, status: RssProcessingStatus) {
    return this.repository.setEntryStatus(id, status)
  }

  async extractArticle(entry: RssEntry): Promise<AppResult<RssEntry>> {
    if (!entry.articleUrl)
      return err({ code: 'validation-error', message: '该 RSS 条目没有文章链接。' })
    try {
      const article = await invoke<RssArticleFetchResult>('fetch_rss_article', {
        input: { url: entry.articleUrl },
      })
      return this.repository.updateArticleContent(entry.id, article)
    } catch (error) {
      return err(normalizeError(error, '无法提取文章正文。'))
    }
  }

  private fetch(
    url: string,
    etag: string | null,
    lastModified: string | null,
    limit: number,
  ): Promise<RssFetchResult> {
    return invoke<RssFetchResult>('fetch_rss_feed', {
      input: {
        url,
        etag,
        lastModified,
        limit: Math.max(1, Math.min(limit, 100)),
      },
    })
  }
}
