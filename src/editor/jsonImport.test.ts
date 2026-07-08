import { describe, expect, it } from 'vitest'

import { parseNotebookJsonDocument } from './jsonImport'

describe('jsonImport', () => {
  it('imports raw tiptap document json', () => {
    const imported = parseNotebookJsonDocument(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'JSON 标题' }],
          },
        ],
      }),
      'backup.json',
    )

    expect(imported.title).toBe('JSON 标题')
    expect(imported.content.type).toBe('doc')
    expect(imported.plainText).toBe('JSON 标题')
  })

  it('imports document objects with contentJson', () => {
    const imported = parseNotebookJsonDocument(
      JSON.stringify({
        title: '备份文档',
        plainText: '备份正文',
        contentJson: JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }],
        }),
      }),
    )

    expect(imported.title).toBe('备份文档')
    expect(imported.plainText).toBe('备份正文')
    expect(imported.content.content?.[0]?.type).toBe('paragraph')
  })

  it('rejects unsupported json', () => {
    expect(() => parseNotebookJsonDocument('{"ok":true}')).toThrow('文档内容')
  })
})
