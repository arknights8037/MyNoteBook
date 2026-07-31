import { describe, expect, it } from 'vitest'

import type { InformationHomeSummary } from '@/models/home/informationHome'
import { findLatestRssInsight } from '@/services/inbox/RssInsightService'

describe('RssInsightService', () => {
  it('extracts the newest structured RSS overview and hot entry references', () => {
    const result = findLatestRssInsight([
      summary('## 今日重点\n- 邮件'),
      summary(
        '## RSS 速览\nAI 工具链出现集中更新。\n\n## 热点条目\n- [RSS:entry-1] 新模型发布 — 三个来源在两小时内连续报道\n- [RSS:entry-2] Rust 版本更新',
      ),
    ])

    expect(result).toMatchObject({
      overviewMarkdown: 'AI 工具链出现集中更新。',
      hotItems: [
        {
          entryId: 'entry-1',
          title: '新模型发布',
          reason: '三个来源在两小时内连续报道',
        },
        { entryId: 'entry-2', title: 'Rust 版本更新', reason: 'Agent 识别为当前热点' },
      ],
    })
  })

  it('ignores unrelated summaries', () => {
    expect(findLatestRssInsight([summary('## 今日重点\n- 处理邮件')])).toBeNull()
  })
})

function summary(content: string): InformationHomeSummary {
  return {
    id: content,
    homeId: 'default',
    sourceCursorAt: 1,
    triggerSource: 'manual',
    status: 'completed',
    content,
    provider: 'test',
    model: 'test',
    error: null,
    generatedAt: 1,
  }
}
