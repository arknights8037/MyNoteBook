import type { InformationHomeSummary } from '@/models/home/informationHome'

export interface RssHotItem {
  entryId: string
  title: string
  reason: string
}

export interface RssInsight {
  summary: InformationHomeSummary
  overviewMarkdown: string
  hotItems: RssHotItem[]
}

export function findLatestRssInsight(summaries: InformationHomeSummary[]): RssInsight | null {
  for (const summary of summaries) {
    if (summary.status !== 'completed') continue
    const overviewMarkdown = readSection(summary.content, ['RSS 速览', 'RSS 摘要'])
    const hotSection = readSection(summary.content, ['热点条目'])
    if (!overviewMarkdown && !hotSection) continue
    return {
      summary,
      overviewMarkdown,
      hotItems: parseHotItems(hotSection),
    }
  }
  return null
}

function readSection(markdown: string, headings: string[]): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => {
    const heading = line.match(/^#{1,4}\s+(.+?)\s*#*\s*$/)?.[1]?.trim()
    return heading ? headings.includes(heading) : false
  })
  if (start < 0) return ''
  const end = lines.findIndex((line, index) => index > start && /^#{1,4}\s+/.test(line))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

function parseHotItems(markdown: string): RssHotItem[] {
  const items: RssHotItem[] = []
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\s*[-*]\s+\[RSS:([^\]]+)]\s*(.+?)(?:\s+[—–-]\s+(.+))?\s*$/i)
    if (!match?.[1] || !match[2]) continue
    items.push({
      entryId: match[1].trim(),
      title: match[2].trim(),
      reason: match[3]?.trim() || 'Agent 识别为当前热点',
    })
    if (items.length >= 8) break
  }
  return items
}
