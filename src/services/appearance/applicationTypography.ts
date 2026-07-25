import type { AppSettings } from '@/models/settings/settings'

const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
])

export function applyApplicationTypography(
  settings: Pick<AppSettings, 'westernFontFamily' | 'chineseFontFamily'>,
): void {
  const western = namedFontFamilies(settings.westernFontFamily)
  const chinese = namedFontFamilies(settings.chineseFontFamily)
  const stack = [...western, ...chinese, 'system-ui', 'sans-serif'].join(', ')
  globalThis.document?.documentElement.style.setProperty('--app-font-family', stack)
}

function namedFontFamilies(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !GENERIC_FONT_FAMILIES.has(part.toLocaleLowerCase()))
    .map((part) => `"${part.replace(/["\\]/g, '')}"`)
}
