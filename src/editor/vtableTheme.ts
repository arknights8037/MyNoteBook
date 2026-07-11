import { getCssColorValue } from '@/services/theme'

export interface VTableThemeColors {
  surface: string
  headerSurface: string
  gridLine: string
  text: string
  searchMatch: string
  selectionBorder: string
  selectionBackground: string
  scrollbar: string
}

export function getVTableThemeColors(): VTableThemeColors {
  const getColor = (name: string, fallback: string): string => getCssColorValue(name) || fallback
  return {
    surface: getColor('--color-bg-elevated', '#ffffff'),
    headerSurface: getColor('--color-editor-table-header', '#f7f8fa'),
    gridLine: getColor('--color-editor-table-border', '#e6e8eb'),
    text: getColor('--color-text-primary', '#282b30'),
    searchMatch: getColor('--color-diff-modified-bg', '#fff3c4'),
    selectionBorder: getColor('--color-accent-primary', '#3975b7'),
    selectionBackground: getColor('--color-selection', 'rgba(57, 117, 183, 0.07)'),
    scrollbar: getColor('--color-text-disabled', 'rgba(99, 107, 118, 0.36)'),
  }
}
