import { describe, expect, it, vi } from 'vitest'

import { exportDocumentToHtml, exportTiptapDocumentToMarkdown } from '@/editor/io/documentExport'

describe('exportTiptapDocumentToMarkdown', () => {
  it('preserves document structure and inline marks for Agent observations', () => {
    expect(
      exportTiptapDocumentToMarkdown({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2, id: 'heading-1' },
            content: [{ type: 'text', text: '运行计划' }],
          },
          {
            type: 'paragraph',
            attrs: { id: 'paragraph-1' },
            content: [
              { type: 'text', text: '重点', marks: [{ type: 'bold' }] },
              { type: 'text', text: '参见' },
              {
                type: 'text',
                text: '规范',
                marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }],
              },
            ],
          },
        ],
      }),
    ).toBe('## 运行计划\n\n**重点**参见[规范](https://example.com/spec)\n')
  })

  it('resolves embedded assets through the injected port when exporting HTML', async () => {
    const resolveAssetUrl = vi.fn(async () => 'data:image/png;base64,portable')

    const html = await exportDocumentToHtml(
      {
        type: 'doc',
        content: [
          {
            type: 'imageFigure',
            attrs: { src: 'asset://asset-image-1', alt: '示例' },
          },
        ],
      },
      { title: '带图文档' },
      { resolveAssetUrl },
    )

    expect(resolveAssetUrl).toHaveBeenCalledWith('asset://asset-image-1')
    expect(html).toContain('src="data:image/png;base64,portable"')
  })
})
