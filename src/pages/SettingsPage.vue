<script setup lang="ts">
import {
  ArrowLeft,
  Check,
  Database,
  FolderOpen,
  Bot,
  Keyboard,
  Monitor,
  MousePointer2,
  Palette,
  RotateCcw,
  ShieldCheck,
  Settings,
  SlidersHorizontal,
  Type,
} from '@lucide/vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { computed, nextTick, onMounted, ref } from 'vue'

import { NButton, NIcon, NInput, NSelect } from '@/ui'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_CHINESE_FONT_FAMILY,
  DEFAULT_WESTERN_FONT_FAMILY,
  shortcutFromKeyboardEvent,
  type AppSettings,
  type ShortcutAction,
} from '@/models/settings'
import {
  AI_PROVIDER_CONFIGS,
  DEFAULT_AI_SETTINGS,
  applyAiProviderDefaults,
  type AiProvider,
  type AiSettings,
} from '@/models/ai'
import {
  getThemeDisplayName,
  getResolvedTheme,
  THEME_DEFINITIONS,
  THEME_OPTIONS,
  type ThemePreference,
} from '@/services/theme'
import { loadSystemFonts } from '@/services/systemFonts'

type BrowserMouseEvent = InstanceType<typeof globalThis.MouseEvent>
type BrowserKeyboardEvent = InstanceType<typeof globalThis.KeyboardEvent>
type BrowserHTMLElement = InstanceType<typeof globalThis.HTMLElement>

const props = withDefaults(
  defineProps<{
    settings: AppSettings
    aiSettings?: AiSettings
    defaultDataDirectory?: string
    dataBusy?: boolean
  }>(),
  {
    aiSettings: () => ({ ...DEFAULT_AI_SETTINGS }),
    defaultDataDirectory: '',
    dataBusy: false,
  },
)

const emit = defineEmits<{
  close: []
  reset: []
  change: [settings: AppSettings]
  aiChange: [settings: AiSettings]
  chooseDataDirectory: []
  restoreDataDirectory: []
}>()

const activeSection = ref('general')
const recordingShortcut = ref<ShortcutAction | null>(null)
const systemFonts = ref<string[]>([])
const sensitivePasswordDraft = ref('')
let sensitivePasswordRequestId = 0

const navigation = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'security', label: '安全', icon: ShieldCheck },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'editor', label: '编辑器', icon: Type },
  { id: 'ai', label: 'AI', icon: Bot },
  { id: 'data', label: '数据', icon: Database },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
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
  emit('aiChange', { ...props.aiSettings, [key]: value })
}

function updateAiProvider(provider: AiProvider): void {
  emit('aiChange', applyAiProviderDefaults(props.aiSettings, provider))
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

function scrollToSection(sectionId: string): void {
  activeSection.value = sectionId
  globalThis.document?.getElementById(`settings-${sectionId}`)?.scrollIntoView({
    behavior: props.settings.reduceMotion ? 'auto' : 'smooth',
    block: 'start',
  })
}

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

    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
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

      <div class="settings-page__body">
        <section id="settings-general" class="settings-section">
          <header class="settings-section__header">
            <span><MousePointer2 :size="18" /></span>
            <div>
              <h2>通用偏好</h2>
              <p>决定应用启动和日常操作的方式。</p>
            </div>
          </header>
          <div class="settings-card">
            <div class="settings-row">
              <span><strong>启动时打开</strong><small>选择进入知识库后的默认页面。</small></span>
              <NSelect
                :value="settings.startupBehavior"
                :options="startupOptions"
                @update:value="update('startupBehavior', $event as AppSettings['startupBehavior'])"
              />
            </div>
            <div class="settings-row">
              <span><strong>快捷新建位置</strong><small>使用快捷键新建页面时采用。</small></span>
              <NSelect
                :value="settings.newDocumentLocation"
                :options="newDocumentOptions"
                @update:value="
                  update('newDocumentLocation', $event as AppSettings['newDocumentLocation'])
                "
              />
            </div>
            <div class="settings-row settings-row--switch">
              <span
                ><strong>删除前确认</strong
                ><small>移入回收站和彻底删除前显示确认窗口。</small></span
              >
              <SwitchRoot
                class="settings-switch"
                :model-value="settings.confirmBeforeDelete"
                @update:model-value="update('confirmBeforeDelete', $event)"
              >
                <SwitchThumb class="settings-switch__thumb" />
              </SwitchRoot>
            </div>
          </div>
        </section>

        <section id="settings-security" class="settings-section">
          <header class="settings-section__header">
            <span><ShieldCheck :size="18" /></span>
            <div>
              <h2>敏感操作授权</h2>
              <p>删除、恢复、导入导出和数据迁移前可要求输入授权密码。</p>
            </div>
          </header>
          <div class="settings-card">
            <div class="settings-row settings-row--switch">
              <span
                ><strong>启用密码授权</strong
                ><small>设置密码后，敏感动作会先要求输入授权密码。</small></span
              >
              <SwitchRoot
                class="settings-switch"
                :model-value="settings.sensitiveActionPasswordEnabled"
                :disabled="!settings.sensitiveActionPasswordHash"
                @update:model-value="updateSensitiveAuthorizationEnabled($event)"
              >
                <SwitchThumb class="settings-switch__thumb" />
              </SwitchRoot>
            </div>
            <div class="settings-row">
              <span
                ><strong>授权密码</strong
                ><small>可随时输入新密码覆盖；留空会关闭密码授权。</small></span
              >
              <NInput
                :value="sensitivePasswordDraft"
                type="password"
                placeholder="输入自定义授权密码"
                autocomplete="new-password"
                @update:value="updateSensitivePassword"
              />
            </div>
          </div>
        </section>

        <section id="settings-appearance" class="settings-section">
          <header class="settings-section__header">
            <span><Palette :size="18" /></span>
            <div>
              <h2>外观</h2>
              <p>主题会跟随选择即时切换。</p>
            </div>
          </header>
          <div class="settings-card">
            <div class="settings-row settings-row--stacked">
              <span
                ><strong>颜色主题</strong><small>选择后立即应用，并保存在本机设置中。</small></span
              >
              <div class="theme-options" role="radiogroup" aria-label="颜色主题">
                <button
                  v-for="option in themeCards"
                  :key="option.value"
                  type="button"
                  role="radio"
                  :aria-checked="settings.theme === option.value"
                  :class="{ 'theme-option--active': settings.theme === option.value }"
                  class="theme-option"
                  @click="updateTheme(option.value)"
                >
                  <span
                    class="theme-option__preview"
                    :style="{
                      backgroundColor: option.theme.colors.background.app,
                      borderColor: option.theme.colors.border.default,
                    }"
                    aria-hidden="true"
                  >
                    <span
                      class="theme-option__sidebar"
                      :style="{ backgroundColor: option.theme.colors.background.sidebar }"
                    ></span>
                    <span
                      class="theme-option__editor"
                      :style="{
                        backgroundColor: option.theme.colors.background.editor,
                        color: option.theme.colors.text.primary,
                      }"
                    >
                      <span :style="{ backgroundColor: option.theme.colors.text.primary }"></span>
                      <span :style="{ backgroundColor: option.theme.colors.text.secondary }"></span>
                    </span>
                    <span
                      class="theme-option__accent"
                      :style="{ backgroundColor: option.theme.colors.accent.primary }"
                    ></span>
                    <span
                      class="theme-option__agent"
                      :style="{ backgroundColor: option.theme.colors.agent.accent }"
                    ></span>
                  </span>
                  <span class="theme-option__body">
                    <strong
                      ><Monitor v-if="option.value === 'system'" :size="14" />{{
                        option.label
                      }}</strong
                    >
                    <small>{{ option.resolvedLabel }}</small>
                  </span>
                  <Check v-if="settings.theme === option.value" :size="15" />
                </button>
              </div>
            </div>
            <div class="settings-row settings-row--switch">
              <span
                ><strong>减少动态效果</strong><small>关闭平滑滚动和非必要过渡动画。</small></span
              >
              <SwitchRoot
                class="settings-switch"
                :model-value="settings.reduceMotion"
                @update:model-value="update('reduceMotion', $event)"
                ><SwitchThumb class="settings-switch__thumb"
              /></SwitchRoot>
            </div>
          </div>
        </section>

        <section id="settings-editor" class="settings-section">
          <header class="settings-section__header">
            <span><Type :size="18" /></span>
            <div>
              <h2>编辑器</h2>
              <p>调整阅读密度、保存和块操作。</p>
            </div>
          </header>
          <div class="settings-card">
            <div class="settings-row">
              <span><strong>正文宽度</strong><small>只影响文章内容，不影响侧栏。</small></span
              ><NSelect
                :value="settings.contentWidth"
                :options="widthOptions"
                @update:value="update('contentWidth', $event as AppSettings['contentWidth'])"
              />
            </div>
            <div class="settings-row">
              <span><strong>正文字号</strong><small>标题会按比例保持层级。</small></span
              ><NSelect
                :value="settings.fontSize"
                :options="fontSizeOptions"
                @update:value="update('fontSize', $event as AppSettings['fontSize'])"
              />
            </div>
            <div class="settings-row">
              <span><strong>正文行距</strong><small>调整长文档的阅读节奏。</small></span
              ><NSelect
                :value="settings.lineHeight"
                :options="lineHeightOptions"
                @update:value="update('lineHeight', $event as AppSettings['lineHeight'])"
              />
            </div>
            <div class="settings-row settings-row--font">
              <span
                ><strong>中文字体</strong><small>从系统字体中选择，不影响公式字段。</small></span
              >
              <div class="settings-font-control">
                <NSelect
                  class="settings-font-select"
                  :value="settings.chineseFontFamily"
                  :options="chineseFontSelectOptions"
                  @update:value="updateFontFamily('chineseFontFamily', $event)"
                />
                <NButton
                  quaternary
                  circle
                  aria-label="恢复默认中文字体"
                  @click="resetFontFamily('chineseFontFamily')"
                  ><template #icon
                    ><NIcon :size="14"><RotateCcw /></NIcon></template
                ></NButton>
              </div>
            </div>
            <div class="settings-row settings-row--font">
              <span
                ><strong>西文字体</strong
                ><small>拉丁字符优先使用该字体，中文仍回落到中文字体。</small></span
              >
              <div class="settings-font-control">
                <NSelect
                  class="settings-font-select"
                  :value="settings.westernFontFamily"
                  :options="westernFontSelectOptions"
                  @update:value="updateFontFamily('westernFontFamily', $event)"
                />
                <NButton
                  quaternary
                  circle
                  aria-label="恢复默认西文字体"
                  @click="resetFontFamily('westernFontFamily')"
                  ><template #icon
                    ><NIcon :size="14"><RotateCcw /></NIcon></template
                ></NButton>
              </div>
            </div>
            <div class="settings-row">
              <span
                ><strong>跳转辅助工具</strong
                ><small>在文档右侧显示锚点或大纲，快速跳到标题。</small></span
              ><NSelect
                :value="settings.jumpAid"
                :options="jumpAidOptions"
                @update:value="update('jumpAid', $event as AppSettings['jumpAid'])"
              />
            </div>
            <div class="settings-row">
              <span
                ><strong>辅助显示位置</strong
                ><small>文档锚点和文档大纲都可显示在文章左侧或右侧。</small></span
              ><NSelect
                :value="settings.jumpAidPosition"
                :options="jumpAidPositionOptions"
                @update:value="update('jumpAidPosition', $event as AppSettings['jumpAidPosition'])"
              />
            </div>
            <div class="settings-row">
              <span
                ><strong>目录显示级别</strong
                ><small>只影响文档大纲；锚点会自动只显示当前文档的主标题层级。</small></span
              ><NSelect
                :value="String(settings.jumpAidMaxLevel)"
                :options="jumpAidMaxLevelOptions"
                @update:value="
                  update('jumpAidMaxLevel', Number($event) as AppSettings['jumpAidMaxLevel'])
                "
              />
            </div>
            <div class="settings-row">
              <span><strong>自动保存</strong><small>停止输入多久后写入知识库。</small></span
              ><NSelect
                :value="String(settings.autosaveDelay)"
                :options="autosaveOptions"
                @update:value="update('autosaveDelay', Number($event))"
              />
            </div>
            <div class="settings-row">
              <span><strong>复制当前块</strong><small>立即在下方重复，或保留至粘贴。</small></span
              ><NSelect
                :value="settings.blockCopyBehavior"
                :options="blockCopyOptions"
                @update:value="
                  update('blockCopyBehavior', $event as AppSettings['blockCopyBehavior'])
                "
              />
            </div>
            <div class="settings-row settings-row--switch">
              <span><strong>拼写检查</strong><small>使用系统词典标记可能的拼写错误。</small></span
              ><SwitchRoot
                class="settings-switch"
                :model-value="settings.spellcheck"
                @update:model-value="update('spellcheck', $event)"
                ><SwitchThumb class="settings-switch__thumb"
              /></SwitchRoot>
            </div>
            <div class="settings-row settings-row--switch">
              <span><strong>显示块控件</strong><small>鼠标经过文章块时显示拖拽手柄。</small></span
              ><SwitchRoot
                class="settings-switch"
                :model-value="settings.showBlockHandles"
                @update:model-value="update('showBlockHandles', $event)"
                ><SwitchThumb class="settings-switch__thumb"
              /></SwitchRoot>
            </div>
          </div>
        </section>

        <section id="settings-data" class="settings-section">
          <header class="settings-section__header">
            <span><Database :size="18" /></span>
            <div>
              <h2>数据存储</h2>
              <p>知识库保存在本机 SQLite 文件中。</p>
            </div>
          </header>
          <div class="settings-card">
            <div class="settings-row settings-row--data">
              <span
                ><strong>当前存储位置</strong
                ><small class="settings-path" :title="currentDataDirectory">{{
                  currentDataDirectory
                }}</small
                ><em>切换时会先备份目标数据库，再复制当前知识库。</em></span
              >
              <div class="settings-row__actions">
                <NButton secondary :loading="dataBusy" @click="emit('chooseDataDirectory')"
                  ><template #icon
                    ><NIcon :size="15"><FolderOpen /></NIcon></template
                  >更改位置</NButton
                >
                <NButton
                  v-if="settings.dataDirectory"
                  quaternary
                  :disabled="dataBusy"
                  @click="emit('restoreDataDirectory')"
                  >恢复默认</NButton
                >
              </div>
            </div>
          </div>
        </section>

        <section id="settings-ai" class="settings-section">
          <header class="settings-section__header">
            <span><Bot :size="18" /></span>
            <div>
              <h2>AI 配置</h2>
              <p>悬浮聊天窗会使用这里的模型和提示词。</p>
            </div>
          </header>
          <div class="settings-card">
            <div class="settings-row">
              <span><strong>服务商</strong><small>决定请求路由和参数兼容方式。</small></span>
              <NSelect
                :value="aiSettings.provider"
                :options="AI_PROVIDER_CONFIGS"
                @update:value="updateAiProvider($event as AiProvider)"
              />
            </div>
            <div class="settings-row">
              <span
                ><strong>Endpoint</strong
                ><small
                  >OpenAI/DeepSeek/千问走 chat/completions；Anthropic 走 messages。</small
                ></span
              >
              <NInput
                :value="aiSettings.endpoint"
                placeholder="https://api.openai.com/v1"
                @update:value="updateAi('endpoint', $event)"
              />
            </div>
            <div class="settings-row">
              <span><strong>模型</strong><small>用于 ask 与 edit 两种模式。</small></span>
              <NInput
                :value="aiSettings.model"
                placeholder="gpt-4.1-mini"
                @update:value="updateAi('model', $event)"
              />
            </div>
            <div class="settings-row">
              <span><strong>API Key</strong><small>仅保存在本机浏览器存储中。</small></span>
              <NInput
                :value="aiSettings.apiKey"
                type="password"
                placeholder="sk-..."
                @update:value="updateAi('apiKey', $event)"
              />
            </div>
            <div class="settings-row">
              <span><strong>温度</strong><small>0 更稳定，2 更发散。</small></span>
              <NInput
                :value="String(aiSettings.temperature)"
                type="number"
                min="0"
                max="2"
                step="0.1"
                @update:value="updateAiTemperature"
              />
            </div>
            <div class="settings-row">
              <span><strong>Top P</strong><small>控制采样范围，1 表示不额外限制。</small></span>
              <NInput
                :value="String(aiSettings.topP)"
                type="number"
                min="0"
                max="1"
                step="0.05"
                @update:value="updateAiTopP"
              />
            </div>
            <div class="settings-row">
              <span
                ><strong>最大输出</strong
                ><small>OpenAI-compatible 与 Anthropic 都会使用。</small></span
              >
              <NInput
                :value="String(aiSettings.maxTokens)"
                type="number"
                min="1"
                step="256"
                @update:value="updateAiMaxTokens"
              />
            </div>
            <div class="settings-row settings-row--stacked">
              <span
                ><strong>系统提示词</strong
                ><small>控制 AI 输出的 Markdown 风格和边界。</small></span
              >
              <textarea
                class="settings-textarea"
                :value="aiSettings.systemPrompt"
                rows="4"
                aria-label="AI 系统提示词"
                @input="
                  updateAi(
                    'systemPrompt',
                    ($event.target as InstanceType<typeof globalThis.HTMLTextAreaElement>).value,
                  )
                "
              ></textarea>
            </div>
          </div>
        </section>

        <section id="settings-shortcuts" class="settings-section">
          <header class="settings-section__header">
            <span><Keyboard :size="18" /></span>
            <div>
              <h2>快捷键</h2>
              <p>点击组合键后，直接按下新的按键组合。</p>
            </div>
          </header>
          <div class="settings-card settings-shortcuts">
            <div
              v-for="row in shortcutRows"
              :key="row.action"
              class="settings-row settings-row--shortcut"
            >
              <span
                ><strong>{{ row.label }}</strong
                ><small>{{ row.description }}</small
                ><em
                  v-if="shortcutConflicts[settings.shortcuts[row.action].toLocaleLowerCase()] > 1"
                  class="shortcut-conflict"
                  >与其他操作冲突</em
                ></span
              >
              <div class="shortcut-control">
                <button
                  type="button"
                  class="shortcut-recorder"
                  :class="{ 'shortcut-recorder--recording': recordingShortcut === row.action }"
                  @click="startRecording(row.action, $event)"
                  @keydown="recordShortcut(row.action, $event)"
                >
                  {{
                    recordingShortcut === row.action
                      ? '请按组合键…'
                      : settings.shortcuts[row.action]
                  }}
                </button>
                <NButton
                  quaternary
                  circle
                  :aria-label="`恢复${row.label}默认快捷键`"
                  :disabled="settings.shortcuts[row.action] === DEFAULT_SHORTCUTS[row.action]"
                  @click="updateShortcut(row.action, DEFAULT_SHORTCUTS[row.action])"
                  ><template #icon
                    ><NIcon :size="14"><RotateCcw /></NIcon></template
                ></NButton>
              </div>
            </div>
          </div>
        </section>

        <aside class="settings-note">
          <Settings :size="17" /><span>设置保存在本机，并立即应用到整个应用。</span>
        </aside>
      </div>
    </div>
  </section>
</template>
