import type {
  RemoteRssEntry,
  RssArticleFetchResult,
  RssEntry,
  RssProcessingStatus,
  RssSource,
} from '@/models/inbox/rss'
import type { AppResult } from '@/models/shared/result'

export interface RssRepository {
  listSources(): Promise<AppResult<RssSource[]>>
  getSource(id: string): Promise<AppResult<RssSource>>
  createSource(source: RssSource): Promise<AppResult<RssSource>>
  deleteSource(id: string): Promise<AppResult<void>>
  updateSyncState(
    id: string,
    state: {
      siteUrl?: string | null
      description?: string | null
      etag?: string | null
      lastModified?: string | null
      lastSyncedAt: number | null
      syncCursorAt?: number | null
      lastError: string | null
      updatedAt: number
    },
  ): Promise<AppResult<RssSource>>
  updateCategory(
    id: string,
    sourceCategory: string,
    updatedAt: number,
  ): Promise<AppResult<RssSource>>
  upsertEntries(
    source: RssSource,
    entries: RemoteRssEntry[],
    syncedAt: number,
  ): Promise<AppResult<number>>
  listEntries(input?: {
    sourceId?: string
    status?: RssProcessingStatus
    limit?: number
  }): Promise<AppResult<RssEntry[]>>
  setEntryStatus(id: string, status: RssProcessingStatus): Promise<AppResult<RssEntry>>
  updateArticleContent(id: string, article: RssArticleFetchResult): Promise<AppResult<RssEntry>>
}
