import { describe, expect, it } from 'vitest'

import { exportTiptapDocumentToMarkdown } from './documentExport'

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
})
