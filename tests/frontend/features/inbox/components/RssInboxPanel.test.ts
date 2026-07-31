import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInformationHome } from '@/models/home/informationHome'
import { ok } from '@/models/shared/result'

const publishSignalRefresh = vi.hoisted(() => vi.fn(async () => ({ eventId: 'event-1' })))
const rssService = vi.hoisted(() => ({
  listSources: vi.fn(),
  listEntries: vi.fn(),
  syncSource: vi.fn(),
  setEntryStatus: vi.fn(),
  extractArticle: vi.fn(),
}))
const homeService = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  listSummaries: vi.fn(),
  updateSummarySettings: vi.fn(),
}))
const tauriEvent = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: Record<string, number> }) => void),
  listen: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: tauriEvent.listen }))
vi.mock('@/app/composition/rssServiceFactory', () => ({
  createRssService: vi.fn(async () => rssService),
}))
vi.mock('@/app/composition/informationHomeServiceFactory', () => ({
  createInformationHomeService: vi.fn(async () => homeService),
}))
vi.mock('@/services/agent/SignalAgentService', () => ({ publishSignalRefresh }))
vi.mock('@/ui/services', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

describe('RssInboxPanel', () => {
  beforeEach(() => {
    tauriEvent.handler = null
    tauriEvent.listen.mockImplementation(async (_event, handler) => {
      tauriEvent.handler = handler
      return tauriEvent.unlisten
    })
  })

  afterEach(() => Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__'))

  it('shows structured hot entries and submits an RSS-scoped summary', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    const home = createInformationHome((prefix) => `${prefix}-test`, 1)
    rssService.listSources.mockResolvedValue(ok([source]))
    rssService.listEntries.mockResolvedValue(ok([entry]))
    homeService.getOrCreate.mockResolvedValue(ok(home))
    homeService.listSummaries.mockResolvedValue(
      ok([
        {
          id: 'summary-1',
          homeId: 'default',
          sourceCursorAt: 2,
          triggerSource: 'manual',
          status: 'completed',
          content:
            '## RSS 速览\n多个来源聚焦工具链更新。\n\n## 热点条目\n- [RSS:entry-1] Rust 工具链更新 — 近期集中发布',
          provider: 'test',
          model: 'test',
          error: null,
          generatedAt: 2,
        },
      ]),
    )
    const { default: RssInboxPanel } = await import('@/features/inbox/components/RssInboxPanel.vue')
    const wrapper = mount(RssInboxPanel, { props: { mode: 'rss' } })
    await flushPromises()

    expect(wrapper.get('.rss-insight-panel').text()).toContain('多个来源聚焦工具链更新')
    expect(wrapper.get('.rss-insight-panel__hot').text()).toContain('近期集中发布')
    expect(wrapper.get('.rss-insight-panel__hot').text()).toContain('工程周报')
    const generate = wrapper
      .findAll('button')
      .find((button) => button.text().includes('生成本期速览'))
    await generate?.trigger('click')

    expect(publishSignalRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'rss', triggerSource: 'manual' }),
    )
    wrapper.unmount()
  })

  it('filters entries by category or subscription source and exposes source metadata', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    const home = createInformationHome((prefix) => `${prefix}-test`, 1)
    rssService.listSources.mockResolvedValue(ok([source, productSource]))
    rssService.listEntries.mockResolvedValue(ok([entry, productEntry]))
    homeService.getOrCreate.mockResolvedValue(ok(home))
    homeService.listSummaries.mockResolvedValue(ok([]))
    const { default: RssInboxPanel } = await import('@/features/inbox/components/RssInboxPanel.vue')
    const wrapper = mount(RssInboxPanel, { props: { mode: 'rss' } })
    await flushPromises()

    const categoryFilters = wrapper.get('[aria-label="按来源分类筛选"]')
    expect(categoryFilters.text()).toContain('技术')
    expect(categoryFilters.text()).toContain('产品')
    await categoryFilters
      .findAll('button')
      .find((button) => button.text() === '技术')
      ?.trigger('click')
    expect(wrapper.get('.rss-entry-list').text()).toContain(entry.title)
    expect(wrapper.get('.rss-entry-list').text()).not.toContain(productEntry.title)

    const sourceFilters = wrapper.get('[aria-label="按订阅源筛选"]')
    await sourceFilters
      .findAll('button')
      .find((button) => button.text() === productSource.displayName)
      ?.trigger('click')
    expect(wrapper.get('.rss-entry-list').text()).toContain(productEntry.title)
    expect(wrapper.get('.rss-entry-list').text()).not.toContain(entry.title)
    const detail = wrapper.get('.rss-entry-detail')
    expect(detail.text()).toContain(productSource.displayName)
    expect(detail.text()).toContain(productSource.sourceCategory)
    expect(detail.text()).toContain(productSource.feedUrl)
    wrapper.unmount()
  })

  it('refreshes repeated Agent updates silently and only once per update timestamp', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', { transformCallback: vi.fn() })
    const home = createInformationHome((prefix) => `${prefix}-test`, 1)
    rssService.listSources.mockResolvedValue(ok([source]))
    rssService.listEntries.mockResolvedValue(ok([entry]))
    homeService.getOrCreate.mockResolvedValue(ok(home))
    homeService.listSummaries.mockResolvedValue(ok([]))
    const { default: RssInboxPanel } = await import('@/features/inbox/components/RssInboxPanel.vue')
    const wrapper = mount(RssInboxPanel, { props: { mode: 'rss' } })
    await flushPromises()
    const initialLoadCount = rssService.listEntries.mock.calls.length

    let resolveEntries: (value: ReturnType<typeof ok>) => void = () => undefined
    rssService.listEntries.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEntries = resolve
      }),
    )
    tauriEvent.handler?.({ payload: { latestUpdateAt: 10, queuedCount: 0, runningCount: 0 } })
    await vi.waitFor(() =>
      expect(rssService.listEntries).toHaveBeenCalledTimes(initialLoadCount + 1),
    )

    expect(wrapper.find('.rss-inbox-layout').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('正在读取本地 RSS')
    tauriEvent.handler?.({ payload: { latestUpdateAt: 10, queuedCount: 0, runningCount: 0 } })
    expect(rssService.listEntries).toHaveBeenCalledTimes(initialLoadCount + 1)

    resolveEntries(ok([entry]))
    await flushPromises()
    expect(wrapper.find('.rss-inbox-layout').exists()).toBe(true)
    wrapper.unmount()
  })
})

const source = {
  id: 'source-1',
  displayName: '工程周报',
  feedUrl: 'https://example.com/feed',
  siteUrl: 'https://example.com',
  description: '',
  sourceCategory: '技术',
  etag: null,
  lastModified: null,
  enabled: true,
  lastSyncedAt: 2,
  syncCursorAt: 2,
  lastError: null,
  createdAt: 1,
  updatedAt: 2,
}

const entry = {
  id: 'entry-1',
  sourceId: 'source-1',
  remoteId: 'remote-1',
  articleUrl: 'https://example.com/article',
  title: 'Rust 工具链更新',
  author: '作者',
  publishedAt: 2,
  updatedAt: null,
  preview: '版本更新摘要',
  bodyText: '版本更新正文',
  contentSource: 'feed',
  articleFetchedAt: null,
  articleFetchError: null,
  categories: ['技术'],
  processingStatus: 'pending',
  syncedAt: 2,
}

const productSource = {
  ...source,
  id: 'source-2',
  displayName: '产品观察',
  feedUrl: 'https://product.example.com/feed',
  siteUrl: 'https://product.example.com',
  sourceCategory: '产品',
}

const productEntry = {
  ...entry,
  id: 'entry-2',
  sourceId: productSource.id,
  remoteId: 'remote-2',
  title: '新产品发布',
  author: '产品团队',
}
