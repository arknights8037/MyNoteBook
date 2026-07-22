<script setup lang="ts">
import {
  ArrowLeft,
  Database,
  Bot,
  Keyboard,
  Palette,
  RotateCcw,
  ShieldCheck,
  Settings,
  SlidersHorizontal,
  Type,
} from '@lucide/vue'
import { computed, nextTick, onMounted, ref, toRef, watch } from 'vue'

import { NButton, NIcon } from '@/ui'
import {
  DEFAULT_CHINESE_FONT_FAMILY,
  DEFAULT_WESTERN_FONT_FAMILY,
  shortcutFromKeyboardEvent,
  type AppSettings,
  type ShortcutAction,
} from '@/models/settings/settings'
import {
  applyAiProviderDefaults,
  createAiSettings,
  updateActiveAiProfile,
  type AiProvider,
  type AiSettings,
} from '@/models/ai/ai'
import {
  getThemeDisplayName,
  getResolvedTheme,
  THEME_DEFINITIONS,
  THEME_OPTIONS,
  type ThemePreference,
} from '@/services/appearance/theme'
import { loadSystemFonts } from '@/services/appearance/systemFonts'
import { fetchAiModelOptions } from '@/services/ai/AiModelService'
import AiSettingsSection from './sections/AiSettingsSection.vue'
import AppearanceSettingsSection from './sections/AppearanceSettingsSection.vue'
import DataSettingsSection from './sections/DataSettingsSection.vue'
import EditorSettingsSection from './sections/EditorSettingsSection.vue'
import GeneralSettingsSection from './sections/GeneralSettingsSection.vue'
import SecuritySettingsSection from './sections/SecuritySettingsSection.vue'
import ShortcutSettingsSection from './sections/ShortcutSettingsSection.vue'
import { provideSettingsSectionContext } from './sections/settingsSectionContext'

type BrowserMouseEvent = InstanceType<typeof globalThis.MouseEvent>
type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>
type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>

const props = withDefaults(
  defineProps<{
    settings: AppSettings
    aiSettings?: AiSettings
    defaultDataDirectory?: string
    dataBusy?: boolean
    contextNavigation?: boolean
  }>(),
  {
    aiSettings: () => createAiSettings('openai'),
    defaultDataDirectory: '',
    dataBusy: false,
    contextNavigation: false,
  },
)

const emit = defineEmits<{
  close: []
  reset: []
  change: [settings: AppSettings]
  aiChange: [settings: AiSettings]
  aiSectionOpen: []
  chooseDataDirectory: []
  restoreDataDirectory: []
}>()

const activeSection = defineModel<string>('section', { default: 'general' })
const settingsBody = ref<BrowserHTMLElement | null>(null)
const recordingShortcut = ref<ShortcutAction | null>(null)
const systemFonts = ref<string[]>([])
const sensitivePasswordDraft = ref('')
const isFetchingAiModels = ref(false)
const aiModelFetchStatus = ref('')
let sensitivePasswordRequestId = 0

const navigation = [
  { id: 'general', label: '通用', description: '启动、新建与开发选项', icon: SlidersHorizontal },
  { id: 'security', label: '安全', description: '敏感操作保护', icon: ShieldCheck },
  { id: 'appearance', label: '外观', description: '主题、字体与动效', icon: Palette },
  { id: 'editor', label: '编辑器', description: '排版、保存与块操作', icon: Type },
  { id: 'ai', label: 'AI', description: '模型、参数与提示词', icon: Bot },
  { id: 'data', label: '数据', description: '本地存储位置', icon: Database },
  { id: 'shortcuts', label: '快捷键', description: '常用操作按键', icon: Keyboard },
]
const widthOptions = [
  { label: '紧凑（720px）', value: 'compact' },
  { label: '标准（850px）', value: 'standard' },
  { label: '宽屏（1000px）', value: 'wide' },
]
const fontSizeOptions = [
  { label: '小（14px）', value: 'small' },
  { label: '标准（16px）', value: 'standard' },
  { label: '大（18px）', value: 'large' },
]
const lineHeightOptions = [
  { label: '紧凑', value: 'compact' },
  { label: '舒适', value: 'comfortable' },
  { label: '宽松', value: 'relaxed' },
]
const jumpAidOptions = [
  { label: '关', value: 'off' },
  { label: '文档锚点', value: 'anchors' },
  { label: '文档大纲', value: 'outline' },
]
const jumpAidPositionOptions = [
  { label: '右侧', value: 'right' },
  { label: '左侧', value: 'left' },
]
const jumpAidMaxLevelOptions = [
  { label: '只显示一级标题', value: '1' },
  { label: '显示到二级标题', value: '2' },
  { label: '显示到三级标题', value: '3' },
  { label: '显示到四级标题', value: '4' },
]
const autosaveOptions = [
  { label: '快速（0.4 秒）', value: '400' },
  { label: '标准（0.8 秒）', value: '800' },
  { label: '节制（1.5 秒）', value: '1500' },
]
const blockCopyOptions = [
  { label: '在下一行重复', value: 'duplicate' },
  { label: '保留至粘贴', value: 'clipboard' },
]
const startupOptions = [
  { label: '上次打开的页面', value: 'last' },
  { label: '最近更新的页面', value: 'recent' },
]
const newDocumentOptions = [
  { label: '当前页面下方', value: 'current' },
  { label: '知识库根目录', value: 'root' },
]
const shortcutRows: Array<{ action: ShortcutAction; label: string; description: string }> = [
  { action: 'search', label: '搜索笔记', description: '打开全局搜索' },
  { action: 'newDocument', label: '新建页面', description: '按通用偏好选择创建位置' },
  { action: 'save', label: '立即保存', description: '立即写入当前更改' },
  { action: 'openSettings', label: '打开设置', description: '进入设置中心' },
  { action: 'importDocument', label: '导入文档', description: '打开格式选择窗口' },
]
const currentDataDirectory = computed(
  () => props.settings.dataDirectory || props.defaultDataDirectory || '系统应用数据目录',
)
const selectedResolvedTheme = computed(() => getResolvedTheme(props.settings.theme))
const chineseFontOptions = computed(() =>
  prioritizeFonts(systemFonts.value, [
    'Microsoft YaHei',
    'PingFang SC',
    'Noto Sans CJK SC',
    'Source Han Sans SC',
    'SimSun',
    'SimHei',
    'KaiTi',
    'FangSong',
  ]),
)
const chineseFontSelectOptions = computed(() =>
  createFontSelectOptions(
    chineseFontOptions.value,
    props.settings.chineseFontFamily,
    DEFAULT_CHINESE_FONT_FAMILY,
    '系统默认中文字体',
  ),
)
const westernFontOptions = computed(() =>
  prioritizeFonts(systemFonts.value, [
    'Segoe UI',
    'Inter',
    'Arial',
    'Helvetica Neue',
    'Calibri',
    'Georgia',
    'Times New Roman',
  ]),
)
const westernFontSelectOptions = computed(() =>
  createFontSelectOptions(
    westernFontOptions.value,
    props.settings.westernFontFamily,
    DEFAULT_WESTERN_FONT_FAMILY,
    '系统默认西文字体',
  ),
)
const themeCards = computed(() =>
  THEME_OPTIONS.map((option) => {
    const theme =
      THEME_DEFINITIONS[option.value === 'system' ? selectedResolvedTheme.value : option.value]
    return {
      ...option,
      theme,
      resolvedLabel:
        option.value === 'system'
          ? `当前：${getThemeDisplayName(theme.id)}`
          : `${theme.name} · ${theme.mode === 'dark' ? '深色' : '浅色'}`,
    }
  }),
)
const aiModelSelectOptions = computed(() => {
  const models = Array.from(
    new Set([props.aiSettings.model, ...props.aiSettings.availableModels].filter(Boolean)),
  )
  return models.map((model) => ({ label: model, value: model }))
})
const shortcutConflicts = computed(() => {
  const counts = Object.values(props.settings.shortcuts).reduce<Record<string, number>>(
    (result, shortcut) => {
      const key = shortcut.toLocaleLowerCase()
      result[key] = (result[key] ?? 0) + 1
      return result
    },
    {},
  )
  return counts
})

function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  emit('change', { ...props.settings, [key]: value })
}

function updateTheme(theme: ThemePreference): void {
  update('theme', theme)
}

function updateFontFamily(key: 'chineseFontFamily' | 'westernFontFamily', value: string): void {
  update(key, value.trim() || defaultFontFamilyForKey(key))
}

function resetFontFamily(key: 'chineseFontFamily' | 'westernFontFamily'): void {
  update(key, defaultFontFamilyForKey(key))
}

function defaultFontFamilyForKey(key: 'chineseFontFamily' | 'westernFontFamily'): string {
  return key === 'chineseFontFamily' ? DEFAULT_CHINESE_FONT_FAMILY : DEFAULT_WESTERN_FONT_FAMILY
}

async function updateSensitivePassword(value: string): Promise<void> {
  const requestId = ++sensitivePasswordRequestId
  sensitivePasswordDraft.value = value
  const trimmed = value.trim()
  if (!trimmed) {
    emit('change', {
      ...props.settings,
      sensitiveActionPasswordHash: '',
      sensitiveActionPasswordEnabled: false,
    })
    return
  }

  const hash = await sha256Hex(trimmed)
  if (requestId !== sensitivePasswordRequestId) return

  emit('change', {
    ...props.settings,
    sensitiveActionPasswordHash: hash,
  })
}

function updateSensitiveAuthorizationEnabled(enabled: boolean): void {
  update(
    'sensitiveActionPasswordEnabled',
    enabled && Boolean(props.settings.sensitiveActionPasswordHash),
  )
}

function updateAi<K extends keyof AiSettings>(key: K, value: AiSettings[K]): void {
  if (key === 'providerProfiles' || key === 'provider' || key === 'systemPrompt') {
    emit('aiChange', { ...props.aiSettings, [key]: value })
    return
  }
  emit('aiChange', updateActiveAiProfile(props.aiSettings, { [key]: value }))
}

function updateAiProvider(provider: AiProvider): void {
  aiModelFetchStatus.value = ''
  emit('aiChange', applyAiProviderDefaults(props.aiSettings, provider))
  emit('aiSectionOpen')
}

async function fetchAiModels(): Promise<void> {
  if (isFetchingAiModels.value) return
  isFetchingAiModels.value = true
  aiModelFetchStatus.value = ''

  try {
    const models = await fetchAiModelOptions(props.aiSettings)
    const currentModel = props.aiSettings.model.trim()
    emit(
      'aiChange',
      updateActiveAiProfile(props.aiSettings, {
        availableModels: models,
        model: currentModel && models.includes(currentModel) ? currentModel : models[0],
      }),
    )
    aiModelFetchStatus.value = `已获取 ${models.length} 个模型`
  } catch (error) {
    aiModelFetchStatus.value = error instanceof Error ? error.message : '获取模型失败。'
  } finally {
    isFetchingAiModels.value = false
  }
}

function updateAiTemperature(value: string): void {
  const parsed = Number(value)
  updateAi('temperature', Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 2)) : 0)
}

function updateAiTopP(value: string): void {
  const parsed = Number(value)
  updateAi('topP', Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : 1)
}

function updateAiMaxTokens(value: string): void {
  const parsed = Number(value)
  updateAi('maxTokens', Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : 2048)
}

function updateShortcut(action: ShortcutAction, shortcut: string): void {
  emit('change', {
    ...props.settings,
    shortcuts: { ...props.settings.shortcuts, [action]: shortcut },
  })
}

async function startRecording(action: ShortcutAction, event: BrowserMouseEvent): Promise<void> {
  recordingShortcut.value = action
  await nextTick()
  ;(event.currentTarget as BrowserHTMLElement | null)?.focus()
}

function recordShortcut(action: ShortcutAction, event: BrowserKeyboardEvent): void {
  if (recordingShortcut.value !== action) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    recordingShortcut.value = null
    return
  }

  const shortcut = shortcutFromKeyboardEvent(event)
  if (!shortcut) return
  updateShortcut(action, shortcut)
  recordingShortcut.value = null
}

async function scrollToSection(sectionId: string): Promise<void> {
  activeSection.value = sectionId
  if (sectionId === 'ai') emit('aiSectionOpen')
  await nextTick()

  const body = settingsBody.value
  const section = globalThis.document?.getElementById(`settings-${sectionId}`)
  if (!body || !section) return

  const bodyRect = body.getBoundingClientRect()
  const sectionRect = section.getBoundingClientRect()
  const top = body.scrollTop + sectionRect.top - bodyRect.top
  if (typeof body.scrollTo === 'function') {
    body.scrollTo({
      top,
      behavior: props.settings.reduceMotion ? 'auto' : 'smooth',
    })
  } else {
    body.scrollTop = top
  }
}

watch(activeSection, (sectionId) => {
  if (props.contextNavigation) void scrollToSection(sectionId)
})

function prioritizeFonts(fonts: string[], preferredFonts: string[]): string[] {
  const fontSet = new Set(fonts)
  return [
    ...preferredFonts.filter((font) => fontSet.has(font)),
    ...fonts.filter((font) => !preferredFonts.includes(font)),
  ].slice(0, 80)
}

function createFontSelectOptions(
  fonts: string[],
  currentFontFamily: string,
  defaultFontFamily: string,
  defaultLabel: string,
) {
  const current = currentFontFamily.trim()
  const options = [
    {
      label: `${defaultLabel}（${getPrimaryFontName(defaultFontFamily)}）`,
      value: defaultFontFamily,
    },
    ...fonts.map((font) => ({ label: font, value: font })),
  ]
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ label: `当前自定义：${formatFontFamilyLabel(current)}`, value: current })
  }
  return options
}

function getPrimaryFontName(fontFamily: string): string {
  return fontFamily.split(',')[0]?.trim() || fontFamily
}

function formatFontFamilyLabel(fontFamily: string): string {
  const fonts = fontFamily
    .split(',')
    .map((font) => font.trim())
    .filter(Boolean)
  if (fonts.length <= 1) return fonts[0] ?? fontFamily
  return `${fonts[0]} 等 ${fonts.length} 项`
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new globalThis.TextEncoder().encode(value)
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

provideSettingsSectionContext({
  settings: toRef(props, 'settings'),
  aiSettings: toRef(props, 'aiSettings'),
  dataBusy: toRef(props, 'dataBusy'),
  sensitivePasswordDraft,
  recordingShortcut,
  isFetchingAiModels,
  aiModelFetchStatus,
  currentDataDirectory,
  themeCards,
  chineseFontSelectOptions,
  westernFontSelectOptions,
  aiModelSelectOptions,
  shortcutConflicts,
  widthOptions,
  fontSizeOptions,
  lineHeightOptions,
  jumpAidOptions,
  jumpAidPositionOptions,
  jumpAidMaxLevelOptions,
  autosaveOptions,
  blockCopyOptions,
  startupOptions,
  newDocumentOptions,
  shortcutRows,
  update,
  updateTheme,
  updateFontFamily,
  resetFontFamily,
  updateSensitivePassword,
  updateSensitiveAuthorizationEnabled,
  updateAi,
  updateAiProvider,
  fetchAiModels,
  updateAiTemperature,
  updateAiTopP,
  updateAiMaxTokens,
  updateShortcut,
  startRecording,
  recordShortcut,
  chooseDataDirectory: () => emit('chooseDataDirectory'),
  restoreDataDirectory: () => emit('restoreDataDirectory'),
})

onMounted(async () => {
  systemFonts.value = await loadSystemFonts()
})
</script>

<template>
  <section class="settings-page" aria-label="设置页面">
    <header class="settings-page__header">
      <NButton quaternary circle aria-label="返回文章" @click="emit('close')">
        <template #icon
          ><NIcon :size="19"><ArrowLeft /></NIcon
        ></template>
      </NButton>
      <div>
        <p>My Notebook</p>
        <h1>设置</h1>
      </div>
      <NButton secondary @click="emit('reset')">
        <template #icon
          ><NIcon :size="15"><RotateCcw /></NIcon
        ></template>
        恢复默认
      </NButton>
    </header>

    <div class="settings-layout" :class="{ 'settings-layout--context-navigation': contextNavigation }">
      <nav v-if="!contextNavigation" class="settings-nav" aria-label="设置分类">
        <button
          v-for="item in navigation"
          :key="item.id"
          type="button"
          :class="{ 'settings-nav__item--active': activeSection === item.id }"
          class="settings-nav__item"
          @click="scrollToSection(item.id)"
        >
          <component :is="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </button>
        <p class="settings-nav__hint">所有更改自动保存</p>
      </nav>

      <div ref="settingsBody" class="settings-page__body">
        <GeneralSettingsSection />

        <SecuritySettingsSection />

        <AppearanceSettingsSection />

        <EditorSettingsSection />

        <DataSettingsSection />

        <AiSettingsSection />

        <ShortcutSettingsSection />

        <aside class="settings-note">
          <Settings :size="17" /><span>设置保存在本机，并立即应用到整个应用。</span>
        </aside>
      </div>
    </div>
  </section>
</template>
