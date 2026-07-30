import type { InformationHomeSummary } from '@/models/home/informationHome'

export interface EmailResultBrief {
  messageId: string
  title: string
  summary: string
}

export interface SignalResultDigest {
  latestResult: InformationHomeSummary | null
  primaryResult: InformationHomeSummary | null
  narrativeMarkdown: string
  emailBriefs: EmailResultBrief[]
  completedCount: number
}

const EVENT_SUMMARY_PREFIX = 'home-summary-signal-event-'
const STRUCTURED_SECTIONS = new Set(['邮件简报', '邮件摘要', 'RSS 速览', 'RSS 摘要', '热点条目'])

export function buildSignalResultDigest(summaries: InformationHomeSummary[]): SignalResultDigest {
  const results = summaries
    .filter((summary) => summary.id.startsWith(EVENT_SUMMARY_PREFIX))
    .sort((left, right) => right.generatedAt - left.generatedAt)
  const completed = results.filter((summary) => summary.status === 'completed')
  const emailBriefs = collectEmailBriefs(completed)
  const primaryResult =
    completed.find((summary) => stripStructuredSections(summary.content).trim()) ??
    completed[0] ??
    null

  return {
    latestResult: results[0] ?? null,
    primaryResult,
    narrativeMarkdown: primaryResult ? stripStructuredSections(primaryResult.content) : '',
    emailBriefs,
    completedCount: completed.length,
  }
}

function collectEmailBriefs(summaries: InformationHomeSummary[]): EmailResultBrief[] {
  const items: EmailResultBrief[] = []
  const seen = new Set<string>()
  for (const summary of summaries) {
    const section = readSection(summary.content, ['邮件简报', '邮件摘要'])
    for (const line of section.split('\n')) {
      const match = line.match(/^\s*[-*]\s+\[EMAIL:([^\]]+)]\s*(.+?)(?:\s+[—–-]\s+(.+))?\s*$/i)
      if (!match?.[1] || !match[2]) continue
      const messageId = match[1].trim()
      if (!messageId || seen.has(messageId)) continue
      seen.add(messageId)
      items.push({
        messageId,
        title: match[2].trim(),
        summary: match[3]?.trim() || 'Agent 已完成该邮件的简要研判',
      })
      if (items.length >= 8) return items
    }
  }
  return items
}

function readSection(markdown: string, headings: string[]): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => {
    const heading = parseHeading(line)
    return heading ? headings.includes(heading.title) : false
  })
  if (start < 0) return ''
  const level = parseHeading(lines[start] ?? '')?.level ?? 2
  const end = lines.findIndex((line, index) => {
    const heading = index > start ? parseHeading(line) : null
    return heading ? heading.level <= level : false
  })
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

function stripStructuredSections(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const retained: string[] = []
  let skippedLevel: number | null = null
  for (const line of lines) {
    const heading = parseHeading(line)
    if (heading && STRUCTURED_SECTIONS.has(heading.title)) {
      skippedLevel = heading.level
      continue
    }
    if (skippedLevel != null) {
      if (!heading || heading.level > skippedLevel) continue
      skippedLevel = null
    }
    retained.push(line)
  }
  return retained
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseHeading(line: string): { level: number; title: string } | null {
  const match = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/)
  return match?.[1] && match[2] ? { level: match[1].length, title: match[2].trim() } : null
}
