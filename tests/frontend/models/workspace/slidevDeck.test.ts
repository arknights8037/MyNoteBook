import { describe, expect, it } from 'vitest'

import {
  addSlidevTextBox,
  createDefaultSlidevSource,
  duplicateSlidevPage,
  insertSlidevPage,
  moveSlidevPage,
  parseSlidevDeck,
  removeSlidevPage,
  updateSlidevPage,
  validateSlidevSource,
} from '@/models/workspace/slidevDeck'

describe('Slidev deck model', () => {
  const createId = (() => {
    let value = 0
    return (prefix: string) => `${prefix}-${++value}`
  })()

  it('creates a valid single-file Slidev deck with a stable page id', () => {
    const source = createDefaultSlidevSource(createId, '演示稿')
    expect(validateSlidevSource(source)).toBeNull()
    expect(parseSlidevDeck(source)).toMatchObject([
      { id: 'slide-1', title: '演示稿', layout: 'default' },
    ])
  })

  it('updates visual text and draggable box data without a parallel JSON model', () => {
    let source = createDefaultSlidevSource(createId, '标题')
    const pageId = parseSlidevDeck(source)[0].id
    source = updateSlidevPage(source, pageId, { title: '新标题', body: '- 第一项\n- 第二项' })
    const added = addSlidevTextBox(source, pageId, createId)
    source = added.source
    const page = parseSlidevDeck(source)[0]
    expect(page).toMatchObject({ title: '新标题', body: '- 第一项\n- 第二项' })
    expect(page.textBoxes).toMatchObject([{ id: added.textBoxId, markdown: '双击编辑文本框' }])
    expect(source).toContain('dragPos:')
    expect(source).toContain('<v-drag')
  })

  it('inserts, duplicates, moves and removes pages while retaining deck headmatter', () => {
    let source = createDefaultSlidevSource(createId, '第一页')
    const first = parseSlidevDeck(source)[0].id
    const inserted = insertSlidevPage(source, first, createId)
    source = updateSlidevPage(inserted.source, inserted.pageId, { title: '第二页' })
    const duplicated = duplicateSlidevPage(source, inserted.pageId, createId)
    source = moveSlidevPage(duplicated.source, duplicated.pageId, -1)
    expect(parseSlidevDeck(source).map((page) => page.title)).toEqual(['第一页', '第二页 副本', '第二页'])
    source = removeSlidevPage(source, first)
    expect(parseSlidevDeck(source).map((page) => page.title)).toEqual(['第二页 副本', '第二页'])
    expect(source).toContain('theme: default')
    expect(validateSlidevSource(source)).toBeNull()
  })
})
