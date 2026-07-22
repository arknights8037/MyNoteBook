import { inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue'

import type { AiProvider, AiSettings } from '@/models/ai/ai'
import type { AppSettings, ShortcutAction } from '@/models/settings/settings'
import type { ThemeDefinition, ThemePreference } from '@/services/appearance/theme'

export interface SettingsSelectOption {
  label: string
  value: string
}

export interface SettingsThemeCard {
  value: ThemePreference
  label: string
  resolvedLabel: string
  theme: ThemeDefinition
}

export interface SettingsSectionContext {
  settings: Readonly<Ref<AppSettings>>
  aiSettings: Readonly<Ref<AiSettings>>
  dataBusy: Readonly<Ref<boolean>>
  sensitivePasswordDraft: Ref<string>
  recordingShortcut: Ref<ShortcutAction | null>
  isFetchingAiModels: Ref<boolean>
  aiModelFetchStatus: Ref<string>
  currentDataDirectory: ComputedRef<string>
  themeCards: ComputedRef<SettingsThemeCard[]>
  chineseFontSelectOptions: ComputedRef<SettingsSelectOption[]>
  westernFontSelectOptions: ComputedRef<SettingsSelectOption[]>
  aiModelSelectOptions: ComputedRef<SettingsSelectOption[]>
  shortcutConflicts: ComputedRef<Record<string, number>>
  widthOptions: SettingsSelectOption[]
  fontSizeOptions: SettingsSelectOption[]
  lineHeightOptions: SettingsSelectOption[]
  jumpAidOptions: SettingsSelectOption[]
  jumpAidPositionOptions: SettingsSelectOption[]
  jumpAidMaxLevelOptions: SettingsSelectOption[]
  autosaveOptions: SettingsSelectOption[]
  blockCopyOptions: SettingsSelectOption[]
  startupOptions: SettingsSelectOption[]
  newDocumentOptions: SettingsSelectOption[]
  shortcutRows: Array<{ action: ShortcutAction; label: string; description: string }>
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  updateTheme: (theme: ThemePreference) => void
  updateFontFamily: (key: 'chineseFontFamily' | 'westernFontFamily', value: string) => void
  resetFontFamily: (key: 'chineseFontFamily' | 'westernFontFamily') => void
  updateSensitivePassword: (value: string) => Promise<void>
  updateSensitiveAuthorizationEnabled: (enabled: boolean) => void
  updateAi: <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => void
  updateAiProvider: (provider: AiProvider) => void
  fetchAiModels: () => Promise<void>
  updateAiTemperature: (value: string) => void
  updateAiTopP: (value: string) => void
  updateAiMaxTokens: (value: string) => void
  updateShortcut: (action: ShortcutAction, shortcut: string) => void
  startRecording: (action: ShortcutAction, event: MouseEvent) => Promise<void>
  recordShortcut: (action: ShortcutAction, event: KeyboardEvent) => void
  chooseDataDirectory: () => void
  restoreDataDirectory: () => void
}

const settingsSectionContextKey: InjectionKey<SettingsSectionContext> = Symbol(
  'settings-section-context',
)

export function provideSettingsSectionContext(context: SettingsSectionContext): void {
  provide(settingsSectionContextKey, context)
}

export function useSettingsSectionContext(): SettingsSectionContext {
  const context = inject(settingsSectionContextKey)
  if (!context) throw new Error('Settings section must be rendered inside SettingsPage.')
  return context
}
