export type ThemeId = 'paper-light' | 'clay-light' | 'nord-dark' | 'graphite-dark'
export type ThemePreference = ThemeId | 'system'
export type ThemeFamily = 'paper' | 'clay' | 'nord' | 'graphite'
export type ThemeMode = 'light' | 'dark'

export type ContentColor =
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'

export interface ThemeDefinition {
  id: ThemeId
  name: string
  family: ThemeFamily
  mode: ThemeMode
  colors: {
    background: {
      app: string
      sidebar: string
      editor: string
      surface: string
      elevated: string
      hover: string
      active: string
      selected: string
    }
    border: {
      subtle: string
      default: string
      strong: string
    }
    text: {
      primary: string
      secondary: string
      tertiary: string
      disabled: string
      placeholder: string
      link: string
      onAccent: string
    }
    accent: {
      primary: string
      hover: string
      active: string
      soft: string
      focus: string
      selection: string
    }
    editor: {
      blockHover: string
      blockSelected: string
      blockHandle: string
      indentGuide: string
      placeholder: string
      quoteBorder: string
      codeBackground: string
      inlineCodeBackground: string
      tableHeader: string
      tableBorder: string
    }
    agent: {
      accent: string
      panelBackground: string
      messageBackground: string
      thinkingBackground: string
      suggestionBackground: string
      citationBackground: string
    }
    diff: {
      addedBackground: string
      addedText: string
      removedBackground: string
      removedText: string
      modifiedBackground: string
      modifiedText: string
    }
    status: {
      success: string
      warning: string
      error: string
      info: string
    }
    content: Record<ContentColor, { background: string; text: string; border: string }>
  }
}

const SETTINGS_STORAGE_KEY = 'my-notebook:settings'
const FALLBACK_THEME_STORAGE_KEY = 'my-notebook:theme-preference'
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export const DEFAULT_THEME_ID: ThemeId = 'paper-light'
export const DEFAULT_DARK_THEME_ID: ThemeId = 'graphite-dark'
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

export const THEME_DEFINITIONS: Record<ThemeId, ThemeDefinition> = {
  'paper-light': {
    id: 'paper-light',
    name: 'Paper Light',
    family: 'paper',
    mode: 'light',
    colors: {
      background: {
        app: '#F7F7F5',
        sidebar: '#F3F3F1',
        editor: '#FFFFFF',
        surface: '#F8F8F7',
        elevated: '#FFFFFF',
        hover: '#EFEFED',
        active: '#E8E8E5',
        selected: '#E6EDFA',
      },
      border: {
        subtle: '#EEEEEB',
        default: '#E2E2DE',
        strong: '#CACAC4',
      },
      text: {
        primary: '#2F2E2A',
        secondary: '#5F5D57',
        tertiary: '#85827A',
        disabled: '#AAA8A1',
        placeholder: '#9A9891',
        link: '#2767C7',
        onAccent: '#FFFFFF',
      },
      accent: {
        primary: '#3478D4',
        hover: '#2868C1',
        active: '#2058A7',
        soft: '#E6EFFB',
        focus: '#76A7E7',
        selection: '#DDEBFC',
      },
      editor: {
        blockHover: 'rgb(47 46 42 / 5%)',
        blockSelected: '#E6EDFA',
        blockHandle: '#85827A',
        indentGuide: '#EEEEEB',
        placeholder: '#9A9891',
        quoteBorder: '#9BA8B7',
        codeBackground: '#F2F3F5',
        inlineCodeBackground: '#F0F0ED',
        tableHeader: '#F4F4F2',
        tableBorder: '#DEDED9',
      },
      agent: {
        accent: '#7C3AED',
        panelBackground: '#FFFFFF',
        messageBackground: '#FBFAFF',
        thinkingBackground: '#F3EEFF',
        suggestionBackground: '#F8F5FF',
        citationBackground: '#EAF5FB',
      },
      diff: {
        addedBackground: '#E8F7EE',
        addedText: '#17643B',
        removedBackground: '#FDECEB',
        removedText: '#A7352B',
        modifiedBackground: '#FFF5D8',
        modifiedText: '#7A4D00',
      },
      status: {
        success: '#18865F',
        warning: '#B7791F',
        error: '#C24135',
        info: '#1B64B0',
      },
      content: createLightContentColors(),
    },
  },
  'clay-light': {
    id: 'clay-light',
    name: 'Clay Light',
    family: 'clay',
    mode: 'light',
    colors: {
      background: {
        app: '#EEE9E1',
        sidebar: '#E8E1D7',
        editor: '#FBF8F2',
        surface: '#F4EFE7',
        elevated: '#FFFDF9',
        hover: '#EDE4D8',
        active: '#E5D9CB',
        selected: '#F2DED2',
      },
      border: {
        subtle: '#E7DDD1',
        default: '#D9CCBD',
        strong: '#C5B5A4',
      },
      text: {
        primary: '#302A25',
        secondary: '#625950',
        tertiary: '#85796E',
        disabled: '#AEA297',
        placeholder: '#94887D',
        link: '#A64D32',
        onAccent: '#FFFFFF',
      },
      accent: {
        primary: '#C15F3C',
        hover: '#A95033',
        active: '#8E432C',
        soft: '#F3DED2',
        focus: '#D89074',
        selection: '#EFD1C1',
      },
      editor: {
        blockHover: 'rgb(48 42 37 / 5%)',
        blockSelected: '#F2DED2',
        blockHandle: '#85796E',
        indentGuide: '#E7DDD1',
        placeholder: '#94887D',
        quoteBorder: '#C15F3C',
        codeBackground: '#EFE7DB',
        inlineCodeBackground: '#EDE4D8',
        tableHeader: '#EEE6DC',
        tableBorder: '#D9CCBD',
      },
      agent: {
        accent: '#7C3AED',
        panelBackground: '#FFFDF9',
        messageBackground: '#FBF7FF',
        thinkingBackground: '#EFE5FF',
        suggestionBackground: '#F7F0FF',
        citationBackground: '#E3F2F4',
      },
      diff: {
        addedBackground: '#E0F0E3',
        addedText: '#275E34',
        removedBackground: '#F8E3DF',
        removedText: '#92372C',
        modifiedBackground: '#F6E8C3',
        modifiedText: '#725000',
      },
      status: {
        success: '#2F7C4F',
        warning: '#A56618',
        error: '#B44435',
        info: '#34758A',
      },
      content: createLightContentColors('clay'),
    },
  },
  'nord-dark': {
    id: 'nord-dark',
    name: 'Nord Dark',
    family: 'nord',
    mode: 'dark',
    colors: {
      background: {
        app: '#242933',
        sidebar: '#292F3A',
        editor: '#2E3440',
        surface: '#343B49',
        elevated: '#3B4252',
        hover: '#39414F',
        active: '#434C5E',
        selected: '#354D5A',
      },
      border: {
        subtle: '#343B49',
        default: '#434C5E',
        strong: '#596476',
      },
      text: {
        primary: '#ECEFF4',
        secondary: '#C7CED9',
        tertiary: '#9EA8B8',
        disabled: '#727D8E',
        placeholder: '#7E8999',
        link: '#88C0D0',
        onAccent: '#20252D',
      },
      accent: {
        primary: '#88C0D0',
        hover: '#8FCAE0',
        active: '#79B2C2',
        soft: '#344D58',
        focus: '#81A1C1',
        selection: '#3B5865',
      },
      editor: {
        blockHover: 'rgb(236 239 244 / 6%)',
        blockSelected: '#354D5A',
        blockHandle: '#9EA8B8',
        indentGuide: '#434C5E',
        placeholder: '#7E8999',
        quoteBorder: '#88C0D0',
        codeBackground: '#242933',
        inlineCodeBackground: '#3B4252',
        tableHeader: '#343B49',
        tableBorder: '#434C5E',
      },
      agent: {
        accent: '#B48EED',
        panelBackground: '#303746',
        messageBackground: '#383F4F',
        thinkingBackground: '#3C3154',
        suggestionBackground: '#342F4D',
        citationBackground: '#2C4A56',
      },
      diff: {
        addedBackground: '#263F35',
        addedText: '#A3E3B4',
        removedBackground: '#4B2C32',
        removedText: '#FFB4AD',
        modifiedBackground: '#4A3D25',
        modifiedText: '#FAD68B',
      },
      status: {
        success: '#A3BE8C',
        warning: '#EBCB8B',
        error: '#BF616A',
        info: '#88C0D0',
      },
      content: createDarkContentColors('nord'),
    },
  },
  'graphite-dark': {
    id: 'graphite-dark',
    name: 'Graphite Dark',
    family: 'graphite',
    mode: 'dark',
    colors: {
      background: {
        app: '#0F1115',
        sidebar: '#13161B',
        editor: '#171A20',
        surface: '#1C2027',
        elevated: '#222730',
        hover: '#232832',
        active: '#2A303B',
        selected: '#292747',
      },
      border: {
        subtle: '#20242B',
        default: '#2C323D',
        strong: '#414957',
      },
      text: {
        primary: '#F1F3F5',
        secondary: '#C2C7D0',
        tertiary: '#9299A5',
        disabled: '#646B76',
        placeholder: '#737B87',
        link: '#9A8CFF',
        onAccent: '#FFFFFF',
      },
      accent: {
        primary: '#8174F2',
        hover: '#9387FA',
        active: '#7163DD',
        soft: '#2B2751',
        focus: '#A69CFF',
        selection: '#373263',
      },
      editor: {
        blockHover: 'rgb(241 243 245 / 6%)',
        blockSelected: '#292747',
        blockHandle: '#9299A5',
        indentGuide: '#2C323D',
        placeholder: '#737B87',
        quoteBorder: '#8174F2',
        codeBackground: '#12151B',
        inlineCodeBackground: '#242A33',
        tableHeader: '#20242B',
        tableBorder: '#2C323D',
      },
      agent: {
        accent: '#B695FF',
        panelBackground: '#1A1E25',
        messageBackground: '#222730',
        thinkingBackground: '#2E2547',
        suggestionBackground: '#27213F',
        citationBackground: '#1E3744',
      },
      diff: {
        addedBackground: '#1E3A2B',
        addedText: '#9FE5B1',
        removedBackground: '#43252A',
        removedText: '#FFB0A8',
        modifiedBackground: '#423620',
        modifiedText: '#F6D37D',
      },
      status: {
        success: '#54A878',
        warning: '#D29A2D',
        error: '#E05B52',
        info: '#6DA2DC',
      },
      content: createDarkContentColors(),
    },
  },
}

export const THEME_DISPLAY_NAMES: Record<ThemeId, string> = {
  'paper-light': '纸张浅色',
  'clay-light': '陶土浅色',
  'nord-dark': '北境深色',
  'graphite-dark': '石墨深色',
}

export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'paper-light', label: THEME_DISPLAY_NAMES['paper-light'] },
  { value: 'clay-light', label: THEME_DISPLAY_NAMES['clay-light'] },
  { value: 'nord-dark', label: THEME_DISPLAY_NAMES['nord-dark'] },
  { value: 'graphite-dark', label: THEME_DISPLAY_NAMES['graphite-dark'] },
]

export function getThemeDisplayName(themeId: ThemeId): string {
  return THEME_DISPLAY_NAMES[themeId]
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEME_DEFINITIONS
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || isThemeId(value)
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  if (isThemePreference(value)) return value
  if (value === 'light') return 'paper-light'
  if (value === 'dark') return 'graphite-dark'
  return DEFAULT_THEME_PREFERENCE
}

export function getThemePreference(): ThemePreference {
  try {
    const settings = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as {
      theme?: unknown
    }
    const theme = normalizeThemePreference(settings.theme)
    if (theme !== DEFAULT_THEME_PREFERENCE || settings.theme === 'system') return theme

    return normalizeThemePreference(globalThis.localStorage?.getItem(FALLBACK_THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
}

export function setThemePreference(preference: ThemePreference): void {
  const normalizedPreference = normalizeThemePreference(preference)
  try {
    const settings = JSON.parse(
      globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY) ?? '{}',
    ) as Record<string, unknown>
    settings.theme = normalizedPreference
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    globalThis.localStorage?.setItem(FALLBACK_THEME_STORAGE_KEY, normalizedPreference)
  } catch {
    try {
      globalThis.localStorage?.setItem(FALLBACK_THEME_STORAGE_KEY, normalizedPreference)
    } catch {
      // The active DOM theme still works when storage is unavailable.
    }
  }
}

export function getResolvedTheme(
  preference: ThemePreference = getThemePreference(),
  prefersDark = systemPrefersDark(),
): ThemeId {
  return preference === 'system'
    ? prefersDark
      ? DEFAULT_DARK_THEME_ID
      : DEFAULT_THEME_ID
    : preference
}

export function applyTheme(preferenceOrTheme: ThemePreference): ThemeId {
  const root = globalThis.document?.documentElement
  const resolvedTheme = getResolvedTheme(preferenceOrTheme)
  const theme = THEME_DEFINITIONS[resolvedTheme]

  if (!root) return resolvedTheme

  root.dataset.theme = resolvedTheme
  root.dataset.themePreference = preferenceOrTheme
  root.dataset.themeMode = theme.mode
  root.style.colorScheme = theme.mode

  for (const [name, value] of Object.entries(getThemeCssVariables(theme))) {
    root.style.setProperty(name, value)
  }

  return resolvedTheme
}

export function subscribeToSystemTheme(callback: (theme: ThemeId) => void): () => void {
  const mediaQuery = globalThis.matchMedia?.(SYSTEM_DARK_QUERY)
  if (!mediaQuery) return () => undefined

  const listener = (): void => {
    const preference = getThemePreference()
    if (preference === 'system') {
      callback(applyTheme(preference))
    }
  }

  mediaQuery.addEventListener('change', listener)
  return () => mediaQuery.removeEventListener('change', listener)
}

export function getThemeCssVariables(theme: ThemeDefinition): Record<string, string> {
  return {
    '--color-bg-app': theme.colors.background.app,
    '--color-bg-sidebar': theme.colors.background.sidebar,
    '--color-bg-editor': theme.colors.background.editor,
    '--color-bg-surface': theme.colors.background.surface,
    '--color-bg-elevated': theme.colors.background.elevated,
    '--color-bg-hover': theme.colors.background.hover,
    '--color-bg-active': theme.colors.background.active,
    '--color-bg-selected': theme.colors.background.selected,
    '--color-border-subtle': theme.colors.border.subtle,
    '--color-border-default': theme.colors.border.default,
    '--color-border-strong': theme.colors.border.strong,
    '--color-text-primary': theme.colors.text.primary,
    '--color-text-secondary': theme.colors.text.secondary,
    '--color-text-tertiary': theme.colors.text.tertiary,
    '--color-text-disabled': theme.colors.text.disabled,
    '--color-text-placeholder': theme.colors.text.placeholder,
    '--color-text-link': theme.colors.text.link,
    '--color-text-on-accent': theme.colors.text.onAccent,
    '--color-accent-primary': theme.colors.accent.primary,
    '--color-accent-hover': theme.colors.accent.hover,
    '--color-accent-active': theme.colors.accent.active,
    '--color-accent-soft': theme.colors.accent.soft,
    '--color-focus-ring': theme.colors.accent.focus,
    '--color-selection': theme.colors.accent.selection,
    '--color-editor-block-hover': theme.colors.editor.blockHover,
    '--color-editor-block-selected': theme.colors.editor.blockSelected,
    '--color-editor-block-handle': theme.colors.editor.blockHandle,
    '--color-editor-indent-guide': theme.colors.editor.indentGuide,
    '--color-editor-placeholder': theme.colors.editor.placeholder,
    '--color-editor-quote-border': theme.colors.editor.quoteBorder,
    '--color-editor-code-bg': theme.colors.editor.codeBackground,
    '--color-editor-inline-code-bg': theme.colors.editor.inlineCodeBackground,
    '--color-editor-table-header': theme.colors.editor.tableHeader,
    '--color-editor-table-border': theme.colors.editor.tableBorder,
    '--color-agent-accent': theme.colors.agent.accent,
    '--color-agent-panel-bg': theme.colors.agent.panelBackground,
    '--color-agent-message-bg': theme.colors.agent.messageBackground,
    '--color-agent-thinking-bg': theme.colors.agent.thinkingBackground,
    '--color-agent-suggestion-bg': theme.colors.agent.suggestionBackground,
    '--color-agent-citation-bg': theme.colors.agent.citationBackground,
    '--color-diff-added-bg': theme.colors.diff.addedBackground,
    '--color-diff-added-text': theme.colors.diff.addedText,
    '--color-diff-removed-bg': theme.colors.diff.removedBackground,
    '--color-diff-removed-text': theme.colors.diff.removedText,
    '--color-diff-modified-bg': theme.colors.diff.modifiedBackground,
    '--color-diff-modified-text': theme.colors.diff.modifiedText,
    '--color-status-success': theme.colors.status.success,
    '--color-status-warning': theme.colors.status.warning,
    '--color-status-error': theme.colors.status.error,
    '--color-status-info': theme.colors.status.info,
    ...getContentColorCssVariables(theme),
    '--accent': theme.colors.accent.primary,
    '--accent-hover': theme.colors.accent.hover,
    '--accent-soft': theme.colors.accent.soft,
    '--accent-ring': colorMix(theme.colors.accent.focus, 0.32),
    '--accent-color': theme.colors.accent.primary,
  }
}

export function getCssColorValue(name: string): string {
  const root = globalThis.document?.documentElement
  if (!root) return ''
  return globalThis.getComputedStyle?.(root).getPropertyValue(name).trim() ?? ''
}

function getContentColorCssVariables(theme: ThemeDefinition): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme.colors.content).flatMap(([name, value]) => [
      [`--color-content-${name}-bg`, value.background],
      [`--color-content-${name}-text`, value.text],
      [`--color-content-${name}-border`, value.border],
    ]),
  )
}

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false
}

function colorMix(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((character) => character + character)
          .join('')
      : normalized
  const number = Number.parseInt(value, 16)
  const red = (number >> 16) & 255
  const green = (number >> 8) & 255
  const blue = number & 255
  return `rgb(${red} ${green} ${blue} / ${Math.round(alpha * 100)}%)`
}

function createLightContentColors(variant: 'paper' | 'clay' = 'paper') {
  const clay = variant === 'clay'
  return {
    gray: {
      background: clay ? '#E7DED2' : '#EFEFED',
      text: clay ? '#5D554B' : '#5F5D57',
      border: clay ? '#D8CABC' : '#E2E2DE',
    },
    brown: { background: '#EFE2D4', text: '#6B4F3A', border: '#D7C0AA' },
    orange: { background: '#F7E0CF', text: '#8E432C', border: '#E3B79B' },
    yellow: { background: '#F6E8BF', text: '#705100', border: '#E3CD8E' },
    green: { background: '#E3F0E1', text: '#2F6A3D', border: '#B9D5B9' },
    blue: { background: '#E3F0F8', text: '#245F8C', border: '#B8D5E8' },
    purple: { background: '#EFE8FA', text: '#6948A3', border: '#D3C3ED' },
    pink: { background: '#F6E3EE', text: '#8C3A66', border: '#E4BED4' },
    red: { background: '#F8DFDB', text: '#92372C', border: '#E7B4AD' },
  }
}

function createDarkContentColors(variant: 'graphite' | 'nord' = 'graphite') {
  const nord = variant === 'nord'
  return {
    gray: {
      background: nord ? '#3B4252' : '#242A33',
      text: nord ? '#D8DEE9' : '#D5D9E0',
      border: nord ? '#4C566A' : '#343B46',
    },
    brown: { background: '#3B3028', text: '#D8B59B', border: '#584638' },
    orange: { background: '#4A2F25', text: '#F0B08E', border: '#704637' },
    yellow: { background: '#43371F', text: '#EBCB8B', border: '#68552D' },
    green: { background: '#243A2B', text: '#A7DDB1', border: '#3A6046' },
    blue: { background: nord ? '#2D4351' : '#203746', text: '#9ED4E5', border: '#3D6578' },
    purple: { background: '#302748', text: '#C7B4FF', border: '#514071' },
    pink: { background: '#40283A', text: '#F2AAD5', border: '#67425C' },
    red: { background: '#44282A', text: '#F3A8A0', border: '#6F3F42' },
  }
}
