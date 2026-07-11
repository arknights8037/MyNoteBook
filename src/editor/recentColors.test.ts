import { beforeEach, describe, expect, it } from 'vitest'

import { loadRecentColors, rememberRecentColor } from './recentColors'

describe('recentColors', () => {
  beforeEach(() => localStorage.clear())

  it('normalizes, deduplicates, limits, and persists colors', () => {
    const colors = rememberRecentColor(
      '#ABCDEF',
      ['#111111', '#abcdef', '#222222', '#333333', '#444444', '#555555'],
      'colors',
    )

    expect(colors).toEqual(['#abcdef', '#111111', '#222222', '#333333', '#444444', '#555555'])
    expect(loadRecentColors('colors')).toEqual(colors)
  })

  it('returns an empty history for malformed storage', () => {
    localStorage.setItem('colors', '{')
    expect(loadRecentColors('colors')).toEqual([])
  })
})
