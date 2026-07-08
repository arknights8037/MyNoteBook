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
  Settings,
  SlidersHorizontal,
  Type,
} from '@lucide/vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { computed, nextTick, ref } from 'vue'

import { NButton, NIcon, NInput, NSelect } from '@/ui'
import {
  DEFAULT_SHORTCUTS,
  shortcutFromKeyboardEvent,
  type AppSettings,
  type ShortcutAction,
} from '@/models/settings'
import { DEFAULT_AI_SETTINGS, type AiProvider, type AiSettings } from '@/models/ai'
import {
  getResolvedTheme,
  THEME_DEFINITIONS,
  THEME_OPTIONS,
  type ThemePreference,
} from '@/services/theme'

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

const navigation = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
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
const aiProviderOptions: Array<{ label: string; value: AiProvider }> = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: '通义千问', value: 'qwen' },
  { label: 'OpenAI 兼容接口', value: 'openai-compatible' },
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
const themeCards = computed(() =>
  THEME_OPTIONS.map((option) => {
    const theme =
      THEME_DEFINITIONS[option.value === 'system' ? selectedResolvedTheme.value : option.value]
    return {
      ...option,
      theme,
      resolvedLabel:
        option.value === 'system' ? `当前：${theme.name}` : theme.mode === 'dark' ? '深色' : '浅色',
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

function updateAi<K extends keyof AiSettings>(key: K, value: AiSettings[K]): void {
  emit('aiChange', { ...props.aiSettings, [key]: value })
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
                :options="aiProviderOptions"
                @update:value="updateAi('provider', $event as AiProvider)"
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
