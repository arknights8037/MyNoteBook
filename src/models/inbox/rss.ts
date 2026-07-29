export type RssProcessingStatus = 'pending' | 'done' | 'archived'
export type RssContentSource = 'summary' | 'feed' | 'article'

export interface RssSource {
  id: string
  displayName: string
  feedUrl: string
  siteUrl: string | null
  description: string
  sourceCategory: string
  etag: string | null
  lastModified: string | null
  enabled: boolean
  lastSyncedAt: number | null
  syncCursorAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface RssEntry {
  id: string
  sourceId: string
  remoteId: string
  articleUrl: string | null
  title: string
  author: string
  publishedAt: number
  updatedAt: number | null
  preview: string
  bodyText: string
  contentSource: RssContentSource
  articleFetchedAt: number | null
  articleFetchError: string | null
  categories: string[]
  processingStatus: RssProcessingStatus
  syncedAt: number
}

export interface RemoteRssEntry {
  remoteId: string
  articleUrl: string | null
  title: string
  author: string
  publishedAt: number
  updatedAt: number | null
  preview: string
  bodyText: string
  contentSource: RssContentSource
  articleFetchedAt: number | null
  articleFetchError: string | null
  categories: string[]
}

export interface RssArticleFetchResult {
  title: string
  author: string
  bodyText: string
  extractedAt: number
}

export interface RssFetchResult {
  notModified: boolean
  effectiveUrl: string
  feedTitle: string | null
  feedDescription: string | null
  siteUrl: string | null
  feedType: string | null
  etag: string | null
  lastModified: string | null
  entries: RemoteRssEntry[]
}

export interface CreateRssSourceInput {
  feedUrl: string
  displayName: string
  sourceCategory: string
}

export function validateRssSourceInput(input: CreateRssSourceInput): string | null {
  if (input.displayName.trim().length > 160) return '订阅名称不能超过 160 个字符。'
  if (!input.sourceCategory.trim() || input.sourceCategory.trim().length > 80)
    return '来源分类不能为空且不能超过 80 个字符。'
  if (input.feedUrl.trim().length > 2048) return 'RSS 地址不能超过 2048 个字符。'
  try {
    const url = new URL(input.feedUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol)) return 'RSS 地址只支持 HTTP 或 HTTPS。'
    if (!url.hostname || url.username || url.password) return 'RSS 地址不能包含登录凭据。'
  } catch {
    return '请输入有效的 RSS 地址。'
  }
  return null
}
