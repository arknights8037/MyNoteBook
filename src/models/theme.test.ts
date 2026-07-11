import { describe, expect, it } from 'vitest'

import { isThemeId, normalizeThemePreference } from './theme'

describe('theme model', () => {
  it('normalizes persisted legacy values without depending on DOM services', () => {
    expect(normalizeThemePreference('light')).toBe('paper-light')
    expect(normalizeThemePreference('dark')).toBe('graphite-dark')
    expect(normalizeThemePreference('unknown')).toBe('system')
    expect(isThemeId('nord-dark')).toBe(true)
  })
})
