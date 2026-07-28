import type {
  RemoteRssEntry,
  RssArticleFetchResult,
  RssContentSource,
  RssEntry,
  RssProcessingStatus,
  RssSource,
} from '@/models/inbox/rss'
import { err, normalizeError, ok, type AppResult } from '@/models/shared/result'
import type { RssRepository } from '@/repositories/inbox/RssRepository'
import { parseJsonStrict } from '@/repositories/shared/jsonCodec'
import type { SqlClient } from '@/repositories/shared/SqlClient'

interface RssSourceRow extends Record<string, unknown> {
  id: string
  display_name: string
  feed_url: string
  site_url: string | null
  description: string
  etag: string | null
  last_modified: string | null
  enabled: number
  last_synced_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

interface RssEntryRow extends Record<string, unknown> {
  id: string
  source_id: string
  remote_id: string
  article_url: string | null
  title: string
  author: string
  published_at: number
  updated_at: number | null
  preview: string
  body_text: string
  content_source: RssContentSource
  article_fetched_at: number | null
  article_fetch_error: string | null
  categories_json: string
  processing_status: RssProcessingStatus
  synced_at: number
}

export class TauriRssRepository implements RssRepository {
  constructor(private readonly sql: SqlClient) {}

  async listSources(): Promise<AppResult<RssSource[]>> {
    try {
      const rows = await this.sql.select<RssSourceRow>(
        'SELECT * FROM rss_sources ORDER BY enabled DESC, updated_at DESC, id ASC',
      )
      return ok(rows.map(mapSource))
    } catch (error) {
      return err(normalizeError(error, '无法读取 RSS 订阅源。'))
    }
  }

  async getSource(id: string): Promise<AppResult<RssSource>> {
    try {
      const rows = await this.sql.select<RssSourceRow>(
        'SELECT * FROM rss_sources WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapSource(rows[0]))
        : err({ code: 'not-found', message: 'RSS 订阅源不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法读取 RSS 订阅源。'))
    }
  }

  async createSource(source: RssSource): Promise<AppResult<RssSource>> {
    try {
      await this.sql.execute(
        `INSERT INTO rss_sources (
          id, display_name, feed_url, site_url, description, etag, last_modified,
          enabled, last_synced_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
        [
          source.id,
          source.displayName,
          source.feedUrl,
          source.siteUrl,
          source.description,
          source.etag,
          source.lastModified,
          source.lastSyncedAt,
          source.createdAt,
          source.updatedAt,
        ],
      )
      return this.getSource(source.id)
    } catch (error) {
      return err(normalizeError(error, '无法保存 RSS 订阅源；请检查地址是否已经添加。'))
    }
  }

  async deleteSource(id: string): Promise<AppResult<void>> {
    try {
      const result = await this.sql.execute('DELETE FROM rss_sources WHERE id = ?', [id])
      return result.rowsAffected === 1
        ? ok(undefined)
        : err({ code: 'not-found', message: 'RSS 订阅源不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法删除 RSS 订阅源。'))
    }
  }

  async updateSyncState(
    id: string,
    state: {
      siteUrl?: string | null
      description?: string | null
      etag?: string | null
      lastModified?: string | null
      lastSyncedAt: number | null
      lastError: string | null
      updatedAt: number
    },
  ): Promise<AppResult<RssSource>> {
    try {
      await this.sql.execute(
        `UPDATE rss_sources SET
          site_url = COALESCE(?, site_url), description = COALESCE(?, description),
          etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
          last_synced_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [
          state.siteUrl ?? null,
          state.description ?? null,
          state.etag ?? null,
          state.lastModified ?? null,
          state.lastSyncedAt,
          state.lastError,
          state.updatedAt,
          id,
        ],
      )
      return this.getSource(id)
    } catch (error) {
      return err(normalizeError(error, '无法更新 RSS 同步状态。'))
    }
  }

  async upsertEntries(
    source: RssSource,
    entries: RemoteRssEntry[],
    syncedAt: number,
  ): Promise<AppResult<number>> {
    try {
      for (const entry of entries) {
        await this.sql.execute(
          `INSERT INTO rss_entries (
            id, source_id, remote_id, article_url, title, author, published_at, updated_at,
            preview, body_text, content_source, article_fetched_at, article_fetch_error,
            categories_json, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, remote_id) DO UPDATE SET
            article_url = excluded.article_url, title = excluded.title, author = excluded.author,
            published_at = excluded.published_at, updated_at = excluded.updated_at,
            preview = excluded.preview,
            body_text = CASE
              WHEN excluded.content_source = 'article' OR rss_entries.content_source != 'article'
                THEN excluded.body_text ELSE rss_entries.body_text END,
            content_source = CASE
              WHEN excluded.content_source = 'article' OR rss_entries.content_source != 'article'
                THEN excluded.content_source ELSE rss_entries.content_source END,
            article_fetched_at = COALESCE(excluded.article_fetched_at, rss_entries.article_fetched_at),
            article_fetch_error = CASE
              WHEN excluded.content_source = 'article' THEN NULL
              WHEN rss_entries.content_source = 'article' THEN rss_entries.article_fetch_error
              ELSE excluded.article_fetch_error END,
            categories_json = excluded.categories_json, synced_at = excluded.synced_at`,
          [
            `${source.id}:${entry.remoteId}`,
            source.id,
            entry.remoteId,
            entry.articleUrl,
            entry.title,
            entry.author,
            entry.publishedAt,
            entry.updatedAt,
            entry.preview,
            entry.bodyText,
            entry.contentSource,
            entry.articleFetchedAt,
            entry.articleFetchError,
            JSON.stringify(entry.categories),
            syncedAt,
          ],
        )
      }
      return ok(entries.length)
    } catch (error) {
      return err(normalizeError(error, '无法保存 RSS 条目。'))
    }
  }

  async listEntries(
    input: { sourceId?: string; status?: RssProcessingStatus; limit?: number } = {},
  ): Promise<AppResult<RssEntry[]>> {
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (input.sourceId) {
      conditions.push('source_id = ?')
      values.push(input.sourceId)
    }
    if (input.status) {
      conditions.push('processing_status = ?')
      values.push(input.status)
    }
    values.push(Math.max(1, Math.min(input.limit ?? 100, 500)))
    try {
      const rows = await this.sql.select<RssEntryRow>(
        `SELECT * FROM rss_entries ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY published_at DESC, id ASC LIMIT ?`,
        values,
      )
      return ok(rows.map(mapEntry))
    } catch (error) {
      return err(normalizeError(error, '无法读取 RSS 收件箱。'))
    }
  }

  async setEntryStatus(id: string, status: RssProcessingStatus): Promise<AppResult<RssEntry>> {
    try {
      const result = await this.sql.execute(
        'UPDATE rss_entries SET processing_status = ? WHERE id = ?',
        [status, id],
      )
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: 'RSS 条目不存在。' })
      const rows = await this.sql.select<RssEntryRow>(
        'SELECT * FROM rss_entries WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapEntry(rows[0]))
        : err({ code: 'not-found', message: 'RSS 条目不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法更新 RSS 条目状态。'))
    }
  }

  async updateArticleContent(
    id: string,
    article: RssArticleFetchResult,
  ): Promise<AppResult<RssEntry>> {
    try {
      const result = await this.sql.execute(
        `UPDATE rss_entries SET body_text = ?, content_source = 'article',
         article_fetched_at = ?, article_fetch_error = NULL WHERE id = ?`,
        [article.bodyText, article.extractedAt, id],
      )
      if (result.rowsAffected !== 1) return err({ code: 'not-found', message: 'RSS 条目不存在。' })
      const rows = await this.sql.select<RssEntryRow>(
        'SELECT * FROM rss_entries WHERE id = ? LIMIT 1',
        [id],
      )
      return rows[0]
        ? ok(mapEntry(rows[0]))
        : err({ code: 'not-found', message: 'RSS 条目不存在。' })
    } catch (error) {
      return err(normalizeError(error, '无法保存提取后的文章正文。'))
    }
  }
}

function mapSource(row: RssSourceRow): RssSource {
  return {
    id: row.id,
    displayName: row.display_name,
    feedUrl: row.feed_url,
    siteUrl: row.site_url,
    description: row.description,
    etag: row.etag,
    lastModified: row.last_modified,
    enabled: Boolean(row.enabled),
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapEntry(row: RssEntryRow): RssEntry {
  const categories = parseJsonStrict<unknown>(row.categories_json, 'RSS 分类')
  return {
    id: row.id,
    sourceId: row.source_id,
    remoteId: row.remote_id,
    articleUrl: row.article_url,
    title: row.title,
    author: row.author,
    publishedAt: Number(row.published_at),
    updatedAt: row.updated_at == null ? null : Number(row.updated_at),
    preview: row.preview,
    bodyText: row.body_text,
    contentSource: row.content_source,
    articleFetchedAt: row.article_fetched_at == null ? null : Number(row.article_fetched_at),
    articleFetchError: row.article_fetch_error,
    categories: Array.isArray(categories)
      ? categories.filter((value): value is string => typeof value === 'string')
      : [],
    processingStatus: row.processing_status,
    syncedAt: Number(row.synced_at),
  }
}
