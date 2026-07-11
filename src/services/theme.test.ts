import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyTheme,
  getResolvedTheme,
  getThemePreference,
  normalizeThemePreference,
  setThemePreference,
  subscribeToSystemTheme,
  THEME_DEFINITIONS,
} from './theme'

describe('theme service', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-theme-preference')
    document.documentElement.removeAttribute('data-theme-mode')
    document.documentElement.removeAttribute('style')
    mockMatchMedia(false)
  })

  it('normalizes current and legacy theme preferences', () => {
    expect(normalizeThemePreference('paper-light')).toBe('paper-light')
    expect(normalizeThemePreference('inkstone-light')).toBe('inkstone-light')
    expect(normalizeThemePreference('dark')).toBe('graphite-dark')
    expect(normalizeThemePreference('light')).toBe('paper-light')
    expect(normalizeThemePreference('unknown')).toBe('system')
  })

  it('resolves system preference to paper light or graphite dark', () => {
    expect(getResolvedTheme('system', false)).toBe('paper-light')
    expect(getResolvedTheme('system', true)).toBe('graphite-dark')
    expect(getResolvedTheme('nord-dark', false)).toBe('nord-dark')
  })

  it('persists theme preference in existing app settings storage', () => {
    localStorage.setItem('my-notebook:settings', JSON.stringify({ autosaveDelay: 800 }))
    setThemePreference('clay-light')

    expect(getThemePreference()).toBe('clay-light')
    expect(JSON.parse(localStorage.getItem('my-notebook:settings') ?? '{}')).toMatchObject({
      autosaveDelay: 800,
      theme: 'clay-light',
    })
  })

  it('updates root dataset, color scheme, and css variables', () => {
    applyTheme('nord-dark')

    expect(document.documentElement.dataset.theme).toBe('nord-dark')
    expect(document.documentElement.dataset.themePreference).toBe('nord-dark')
    expect(document.documentElement.dataset.themeMode).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(
      document.documentElement.style.getPropertyValue('--color-bg-app').trim(),
    ).toBe(THEME_DEFINITIONS['nord-dark'].colors.background.app)
  })

  it('reacts to system theme changes only while preference is system', () => {
    const mediaQuery = mockMatchMedia(false)
    setThemePreference('system')
    const unsubscribe = subscribeToSystemTheme(applyTheme)

    mediaQuery.setMatches(true)
    expect(document.documentElement.dataset.theme).toBe('graphite-dark')

    setThemePreference('paper-light')
    mediaQuery.setMatches(false)
    expect(document.documentElement.dataset.theme).toBe('graphite-dark')

    unsubscribe()
  })
})

function mockMatchMedia(initialMatches: boolean): {
  setMatches: (matches: boolean) => void
} {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  let matches = initialMatches

  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      get matches() {
        return matches
      },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener)
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  })

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches
      for (const listener of listeners) {
        listener({ matches: nextMatches } as MediaQueryListEvent)
      }
    },
  }
}
