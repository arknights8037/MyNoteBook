import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import RssNewsHomeWidget from '@/features/information-home/components/RssNewsHomeWidget.vue'
import type { InformationHomeSummary } from '@/models/home/informationHome'
import type { RssEntry, RssSource } from '@/models/inbox/rss'
import { ok } from '@/models/shared/result'

const rssService = vi.hoisted(() => ({
  listSources: vi.fn(),
  listEntries: vi.fn(),
  setEntryStatus: vi.fn(),
}))

vi.mock('@/app/composition/rssServiceFactory', () => ({
  createRssService: vi.fn(async () => rssService),
}))

describe('RssNewsHomeWidget', () => {
  it('shows automatic insight status without summary controls', async () => {
    rssService.listSources.mockResolvedValue(ok([source]))
    rssService.listEntries.mockResolvedValue(ok([entry]))
    const wrapper = mount(RssNewsHomeWidget, {
      props: { limit: 8, summary },
    })
    await flushPromises()

    expect(wrapper.get('.home-rss-insight-status').text()).toBe('已自动研判 · 1 条热点')
    expect(wrapper.text()).not.toContain('生成速览')
    expect(wrapper.text()).not.toContain('自动 开')
    expect(wrapper.text()).not.toContain('自动 关')
    expect(wrapper.get('.home-rss-hot-label').text()).toBe('热点')
    expect(wrapper.text()).toContain('Rust 工具链更新')
    expect(wrapper.text()).toContain('近期集中发布')
    expect(wrapper.text()).not.toContain('Rust toolchain update')
    wrapper.unmount()
  })

  it('keeps a hot item visible until the RSS system confirms its new status', async () => {
    let resolveStatus: (value: ReturnType<typeof ok>) => void = () => undefined
    rssService.listSources.mockResolvedValue(ok([source]))
    rssService.listEntries.mockResolvedValue(ok([entry]))
    rssService.setEntryStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
    )
    const wrapper = mount(RssNewsHomeWidget, { props: { limit: 8, summary } })
    await flushPromises()

    await wrapper.get('button[aria-label="标记为已处理"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.dashboard-widget-list li').attributes('aria-busy')).toBe('true')
    expect(wrapper.text()).toContain('正在向 RSS 系统提交处理结果')

    resolveStatus(ok({ ...entry, processingStatus: 'done' }))
    await flushPromises()
    expect(wrapper.find('.dashboard-widget-list').exists()).toBe(false)
  })
})

const source: RssSource = {
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

const entry: RssEntry = {
  id: 'entry-1',
  sourceId: 'source-1',
  remoteId: 'remote-1',
  articleUrl: 'https://example.com/article',
  title: 'Rust toolchain update',
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

const summary: InformationHomeSummary = {
  id: 'summary-1',
  homeId: 'default',
  sourceCursorAt: 2,
  triggerSource: 'auto',
  status: 'completed',
  content:
    '## RSS 速览\n工具链集中更新。\n\n## 热点条目\n- [RSS:entry-1] Rust 工具链更新 — 近期集中发布',
  provider: 'test',
  model: 'test',
  error: null,
  generatedAt: 2,
}
