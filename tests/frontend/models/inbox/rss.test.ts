import { describe, expect, it } from 'vitest'

import { validateRssSourceInput } from '@/models/inbox/rss'

describe('RSS source validation', () => {
  it('accepts HTTP feeds and rejects credentials or non-web schemes', () => {
    expect(
      validateRssSourceInput({
        displayName: '',
        feedUrl: 'https://example.com/feed.xml',
        sourceCategory: '技术',
      }),
    ).toBeNull()
    expect(
      validateRssSourceInput({
        displayName: '',
        feedUrl: 'file:///tmp/feed.xml',
        sourceCategory: '技术',
      }),
    ).toContain('HTTP')
    expect(
      validateRssSourceInput({
        displayName: '',
        feedUrl: 'https://user:pass@example.com/feed',
        sourceCategory: '技术',
      }),
    ).toContain('登录凭据')
  })
})
