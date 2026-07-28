import { describe, expect, it } from 'vitest'

import {
  matchesSearchFields,
  normalizeSearchText,
  rankSearchItems,
} from '@/models/shared/searchRanking'

describe('searchRanking', () => {
  it('normalizes width, accents, punctuation and case', () => {
    expect(normalizeSearchText('  Ａgént／MVP  ')).toBe('agent mvp')
    expect(matchesSearchFields('agentmvp', [{ text: 'Agent / MVP' }])).toBe(true)
    expect(matchesSearchFields('产品需求', [{ text: '产品-需求文档' }])).toBe(true)
  })

  it('supports ordered abbreviated matching without accepting reversed text', () => {
    expect(matchesSearchFields('amvp', [{ text: 'Agent Model View Protocol' }])).toBe(true)
    expect(matchesSearchFields('vpa', [{ text: 'Agent View Protocol' }])).toBe(false)
  })

  it('requires every query token and ranks title matches before metadata matches', () => {
    const items = [
      { id: 'metadata', title: '实施记录', path: 'Agent Runtime' },
      { id: 'title', title: 'Agent Runtime 维护', path: '工程' },
      { id: 'partial', title: 'Agent 手册', path: '产品' },
    ]
    const ranked = rankSearchItems(items, 'agent runtime', (item) => [
      { text: item.title, weight: 3 },
      { text: item.path, weight: 1 },
    ])

    expect(ranked.map((item) => item.id)).toEqual(['title', 'metadata'])
  })
})
