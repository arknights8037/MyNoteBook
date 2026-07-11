import { describe, expect, it } from 'vitest'

import { collectEditorOutlineItems, filterEditorOutlineItems } from './editorOutline'

describe('editorOutline', () => {
  const items = collectEditorOutlineItems({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'one', level: 1 }, content: [{ type: 'text', text: 'One' }] },
      { type: 'heading', attrs: { id: 'two', level: 3 }, content: [{ type: 'text', text: 'Two' }] },
      { type: 'collapsibleBlock', attrs: { id: 'three', headingLevel: 2, title: 'Three' } },
      { type: 'paragraph', attrs: { id: 'ignored' } },
    ],
  })

  it('collects navigable heading and collapsible blocks', () => {
    expect(items).toEqual([
      { id: 'one', index: 0, level: 1, title: 'One' },
      { id: 'two', index: 1, level: 3, title: 'Two' },
      { id: 'three', index: 2, level: 2, title: 'Three' },
    ])
  })

  it('filters anchor and outline modes independently from Vue state', () => {
    expect(filterEditorOutlineItems(items, 'anchors', 4).map((item) => item.id)).toEqual(['one'])
    expect(filterEditorOutlineItems(items, 'outline', 2).map((item) => item.id)).toEqual([
      'one',
      'three',
    ])
    expect(filterEditorOutlineItems(items, 'off', 4)).toEqual([])
  })
})
