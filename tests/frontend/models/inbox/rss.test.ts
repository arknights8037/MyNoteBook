import { describe, expect, it } from 'vitest'

import { validateRssSourceInput } from '@/models/inbox/rss'

describe('RSS source validation', () => {
  it('accepts HTTP feeds and rejects credentials or non-web schemes', () => {
    expect(
      validateRssSourceInput({ displayName: '', feedUrl: 'https://example.com/feed.xml' }),
    ).toBeNull()
    expect(validateRssSourceInput({ displayName: '', feedUrl: 'file:///tmp/feed.xml' })).toContain(
      'HTTP',
    )
    expect(
      validateRssSourceInput({ displayName: '', feedUrl: 'https://user:pass@example.com/feed' }),
    ).toContain('登录凭据')
  })
})
