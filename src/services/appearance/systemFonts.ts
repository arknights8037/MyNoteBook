import { invoke } from '@tauri-apps/api/core'

const FALLBACK_SYSTEM_FONTS = [
  'Segoe UI',
  'Arial',
  'Helvetica Neue',
  'Inter',
  'Microsoft YaHei',
  'SimSun',
  'SimHei',
  'KaiTi',
  'FangSong',
  'PingFang SC',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
]

export async function loadSystemFonts(): Promise<string[]> {
  try {
    const fonts = await invoke<string[]>('get_system_fonts')
    return normalizeFontList(fonts)
  } catch {
    return normalizeFontList(FALLBACK_SYSTEM_FONTS)
  }
}

function normalizeFontList(fonts: string[]): string[] {
  return Array.from(
    new Set(
      fonts.map((font) => font.trim()).filter((font) => font.length > 0 && font.length <= 80),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}
