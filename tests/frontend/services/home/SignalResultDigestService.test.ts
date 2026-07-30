import { describe, expect, it } from 'vitest'

import type { InformationHomeSummary } from '@/models/home/informationHome'
import { buildSignalResultDigest } from '@/services/home/SignalResultDigestService'

describe('SignalResultDigestService', () => {
  it('consumes event processing results and extracts deduplicated email jump items', () => {
    const result = buildSignalResultDigest([
      summary('legacy-summary', 30, '## 今日重点\n这条旧摘要不属于系统事件处理结果。'),
      summary(
        'home-summary-signal-event-new',
        20,
        '# 工作信号摘要\n\n## 处理结论\n构建问题需要尽快处理。\n\n## 邮件简报\n- [EMAIL:account-1:INBOX:123] CI 构建失败 — Rust 检查未通过\n- [EMAIL:mail-2] 服务到期提醒\n\n## RSS 速览\n- 工具链更新\n\n## 热点条目\n- [RSS:rss-1] 新版本发布 — 多个来源报道',
      ),
      summary(
        'home-summary-signal-event-old',
        10,
        '## 邮件简报\n- [EMAIL:account-1:INBOX:123] 旧标题 — 旧摘要\n- [EMAIL:mail-3] 账单提醒 — 本月账单已生成',
      ),
    ])

    expect(result.completedCount).toBe(2)
    expect(result.primaryResult?.id).toBe('home-summary-signal-event-new')
    expect(result.narrativeMarkdown).toContain('构建问题需要尽快处理')
    expect(result.narrativeMarkdown).not.toContain('邮件简报')
    expect(result.narrativeMarkdown).not.toContain('RSS 速览')
    expect(result.emailBriefs).toEqual([
      {
        messageId: 'account-1:INBOX:123',
        title: 'CI 构建失败',
        summary: 'Rust 检查未通过',
      },
      {
        messageId: 'mail-2',
        title: '服务到期提醒',
        summary: '智能助手已完成该邮件的简要研判',
      },
      { messageId: 'mail-3', title: '账单提醒', summary: '本月账单已生成' },
    ])
  })

  it('ignores non-event summaries even when they are newer', () => {
    const result = buildSignalResultDigest([
      summary('legacy-summary', 20, '## 邮件简报\n- [EMAIL:legacy] 旧摘要'),
      summary('home-summary-signal-event-1', 10, '事件处理完成。'),
    ])

    expect(result.latestResult?.id).toBe('home-summary-signal-event-1')
    expect(result.emailBriefs).toEqual([])
  })
})

function summary(id: string, generatedAt: number, content: string): InformationHomeSummary {
  return {
    id,
    homeId: 'default',
    sourceCursorAt: generatedAt,
    triggerSource: 'auto',
    status: 'completed',
    content,
    provider: 'test',
    model: 'test',
    error: null,
    generatedAt,
  }
}
