import { describe, expect, it } from 'vitest'

import { parseMarkdownDocument } from './markdownImport'

describe('markdownImport', () => {
  it('uses the first h1 as the imported document title', () => {
    const imported = parseMarkdownDocument('# 项目说明\n\n正文内容', 'fallback.md')

    expect(imported.title).toBe('项目说明')
    expect(imported.content.content?.[0]).toMatchObject({
      type: 'heading',
      attrs: expect.objectContaining({ level: 1 }),
    })
    expect(imported.plainText).toContain('正文内容')
  })

  it('strips an UTF-8 BOM before parsing the first heading', () => {
    const imported = parseMarkdownDocument('\uFEFF# 项目说明\n\n正文内容', 'fallback.md')

    expect(imported.title).toBe('项目说明')
    expect(imported.content.content?.[0]).toMatchObject({
      type: 'heading',
      attrs: expect.objectContaining({ level: 1 }),
    })
  })

  it('converts common markdown blocks into tiptap content', () => {
    const imported = parseMarkdownDocument(
      [
        '## 二级标题',
        '',
        '- 第一项',
        '- 第二项',
        '',
        '> 引用内容',
        '',
        '```ts',
        'const ok = true',
        '```',
        '',
        '---',
      ].join('\n'),
    )

    expect(imported.content.content?.map((node) => node.type)).toEqual([
      'heading',
      'bulletList',
      'blockquote',
      'codeBlock',
      'horizontalRule',
    ])
  })

  it('converts markdown task list items into task blocks', () => {
    const imported = parseMarkdownDocument(['- [x] 已完成', '- [ ] 待处理'].join('\n'))

    expect(imported.content.content?.[0]).toMatchObject({
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: expect.objectContaining({ checked: true }),
        },
        {
          type: 'taskItem',
          attrs: expect.objectContaining({ checked: false }),
        },
      ],
    })
    expect(imported.plainText).toContain('已完成')
  })

  it('imports fourth-level headings', () => {
    const imported = parseMarkdownDocument('#### 四级标题')

    expect(imported.content.content?.[0]).toMatchObject({
      type: 'heading',
      attrs: expect.objectContaining({ level: 4 }),
    })
  })

  it('preserves mermaid fence language on import', () => {
    const imported = parseMarkdownDocument(
      ['```mermaid', 'flowchart TD', '  A[开始] --> B[结束]', '```'].join('\n'),
    )

    expect(imported.content.content?.[0]).toMatchObject({
      type: 'codeBlock',
      attrs: expect.objectContaining({ language: 'mermaid' }),
    })
  })

  it('converts markdown tables into table blocks', () => {
    const imported = parseMarkdownDocument(
      ['| 字段 | 说明 |', '| --- | --- |', '| 名称 | 文档标题 |', '| 状态 | 已完成 |'].join('\n'),
    )

    expect(imported.content.content?.[0]).toMatchObject({
      type: 'tableBlock',
      attrs: {
        rows: [
          ['字段', '说明'],
          ['名称', '文档标题'],
          ['状态', '已完成'],
        ],
      },
    })
    expect(imported.plainText).toContain('名称\t文档标题')
  })

  it('converts display math fences into math blocks', () => {
    const imported = parseMarkdownDocument(
      ['$$', 'E = mc^2', '$$', '', '```latex', '\\frac{a}{b}', '```'].join('\n'),
    )
    const bracketImported = parseMarkdownDocument('\\[a^2 + b^2 = c^2\\]')

    expect(imported.content.content?.map((node) => node.type)).toEqual(['mathBlock', 'mathBlock'])
    expect(imported.content.content?.[0]).toMatchObject({
      attrs: { latex: 'E = mc^2' },
    })
    expect(imported.content.content?.[1]).toMatchObject({
      attrs: { latex: '\\frac{a}{b}' },
    })
    expect(bracketImported.content.content?.[0]).toMatchObject({
      type: 'mathBlock',
      attrs: { latex: 'a^2 + b^2 = c^2' },
    })
  })
})
