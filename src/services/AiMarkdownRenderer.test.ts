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
})
