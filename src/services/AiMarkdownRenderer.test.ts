import { describe, expect, it } from 'vitest'

import { renderAiMarkdown } from './AiMarkdownRenderer'

describe('renderAiMarkdown', () => {
  it('renders common markdown and escapes unsafe text', () => {
    const html = renderAiMarkdown('# Title\n\n**bold** <script>alert(1)</script>')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<script>')
  })

  it('returns a stable empty state', () => {
    expect(renderAiMarkdown('')).toContain('markdown-preview__empty')
  })

  it('rejects active URLs and escapes event-handler markup before v-html rendering', () => {
    const html = renderAiMarkdown(
      [
        '[script URL](javascript:alert(1))',
        '[data URL](data:text/html,<svg onload=alert(1)>)',
        '[safe](https://example.com/path?q=1)',
        '<img src=x onerror="alert(1)">',
        '<svg><script>alert(1)</script></svg>',
      ].join('\n\n'),
    )

    expect(html).toContain('href="https://example.com/path?q=1"')
    expect(html).toContain('rel="noreferrer"')
    expect(html).not.toMatch(/href="(?:javascript|data):/i)
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i)
    expect(html).not.toMatch(/<[^>]+\son(?:error|load)=/i)
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })
})
