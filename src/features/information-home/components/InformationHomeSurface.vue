<script setup lang="ts">
import { Check, ChevronRight, Pencil, Plus, RotateCcw, Undo2, X } from '@lucide/vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { createInformationHomeService } from '@/app/composition/informationHomeServiceFactory'
import type { AiSettings } from '@/models/ai/ai'
import {
  createDefaultInformationHomePayload,
  type InformationHome,
  type InformationHomeGridPosition,
  type InformationHomePayload,
  type InformationHomeSummary,
  type InformationHomeWidget,
  type InformationHomeWidgetType,
} from '@/models/home/informationHome'
import { publishSignalRefresh } from '@/services/agent/SignalAgentService'
import type { InformationHomeService } from '@/services/home/InformationHomeService'
import { findLatestRssInsight } from '@/services/inbox/RssInsightService'
import {
  getInformationHomeWidgetDefinition,
  INFORMATION_HOME_WIDGET_REGISTRY,
} from '../informationHomeWidgetRegistry'
import InformationHomeGrid from './InformationHomeGrid.vue'

type BrowserMouseEvent = InstanceType<typeof globalThis.MouseEvent>
type PersistenceState = 'idle' | 'saving' | 'saved' | 'error'

const props = defineProps<{
  aiSettings: AiSettings
  ensureAiSecretLoaded: () => Promise<boolean>
}>()
const emit = defineEmits<{ openInbox: [section: 'email' | 'rss', id?: string] }>()

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const canListenToTauriEvents =
  typeof Reflect.get(globalThis, '__TAURI_INTERNALS__') === 'object' &&
  typeof Reflect.get(
    Reflect.get(globalThis, '__TAURI_INTERNALS__') as object,
    'transformCallback',
  ) === 'function'
const home = ref<InformationHome | null>(null)
const draft = ref<InformationHomePayload>(createDefaultInformationHomePayload(createId))
const summaries = ref<InformationHomeSummary[]>([])
const editing = ref(false)
const showMenu = ref(false)
const menuPosition = ref({ x: 0, y: 0 })
const activeSubmenu = ref<'add' | 'layout' | null>(null)
const undoStack = ref<InformationHomePayload[]>([])
const loading = ref(false)
const saving = ref(false)
const settingsSaving = ref(false)
const widgetSettingsStates = ref<Record<string, PersistenceState>>({})
const summarySettingsState = ref<PersistenceState>('idle')
const generatingSummary = ref(false)
const error = ref('')
let servicePromise: Promise<InformationHomeService> | null = null
let unlistenSignalAgent: UnlistenFn | null = null
let lastSignalUpdateAt: number | null = null
let silentRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let settingsSaveQueue = Promise.resolve()
let pendingSettingsSaves = 0
const pendingWidgetSettingsSaves = new Map<string, number>()
const widgetFeedbackTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>()
let summaryFeedbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null

const HOME_MUTATION_TOOLS = new Set(['upsert_personal_todo', 'upsert_personal_calendar_event'])

const service = () => (servicePromise ??= createInformationHomeService())
const latestSummary = computed(() => summaries.value[0] ?? null)
const latestRssSummary = computed(
  () => summaries.value.find((summary) => findLatestRssInsight([summary]) !== null) ?? null,
)
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(home.value?.payload))

async function load(showLoading = true): Promise<void> {
  if (!native) return
  if (showLoading) loading.value = true
  error.value = ''
  const [homeResult, summaryResult] = await Promise.all([
    (await service()).getOrCreate(),
    (await service()).listSummaries(20),
  ])
  if (showLoading) loading.value = false
  if (!homeResult.ok) return void (error.value = homeResult.error.message)
  if (!summaryResult.ok) return void (error.value = summaryResult.error.message)
  home.value = homeResult.value
  summaries.value = summaryResult.value
  if (!editing.value || !dirty.value) draft.value = clone(homeResult.value.payload)
}

function scheduleSilentRefresh(): void {
  if (silentRefreshTimer != null) return
  silentRefreshTimer = globalThis.setTimeout(() => {
    silentRefreshTimer = null
    void load(false)
  }, 120)
}

function beginEdit(): void {
  if (!home.value || settingsSaving.value) return
  draft.value = clone(home.value.payload)
  undoStack.value = []
  editing.value = true
  showMenu.value = false
}

function openContextMenu(event: BrowserMouseEvent): void {
  const width = 558
  const height = editing.value ? 340 : 300
  menuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, globalThis.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, globalThis.innerHeight - height - 8)),
  }
  activeSubmenu.value = null
  showMenu.value = true
}

function closeContextMenu(): void {
  showMenu.value = false
  activeSubmenu.value = null
}

function addWidgetFromMenu(type: InformationHomeWidgetType): void {
  if (!editing.value) beginEdit()
  if (!editing.value) return
  addWidget(type)
  activeSubmenu.value = null
  showMenu.value = false
}

function cancelEdit(): void {
  if (home.value) draft.value = clone(home.value.payload)
  undoStack.value = []
  editing.value = false
}

async function save(): Promise<void> {
  if (!home.value) return
  saving.value = true
  const result = await (await service()).savePayload(home.value, clone(draft.value))
  saving.value = false
  if (!result.ok) return void (error.value = result.error.message)
  home.value = result.value
  draft.value = clone(result.value.payload)
  undoStack.value = []
  editing.value = false
}

function mutate(mutator: (payload: InformationHomePayload) => void): void {
  undoStack.value.push(clone(draft.value))
  if (undoStack.value.length > 30) undoStack.value.shift()
  const next = clone(draft.value)
  mutator(next)
  draft.value = next
}

function undo(): void {
  const previous = undoStack.value.pop()
  if (previous) draft.value = previous
}

function reset(): void {
  mutate((payload) => {
    payload.widgets = createDefaultInformationHomePayload(createId).widgets
  })
}

function resetFromMenu(): void {
  reset()
  showMenu.value = false
}

function undoFromMenu(): void {
  undo()
  showMenu.value = false
}

function addWidget(type: InformationHomeWidgetType): void {
  mutate((payload) => payload.widgets.push(createWidget(type, payload.widgets)))
}

function copyWidget(id: string): void {
  if (!editing.value) beginEdit()
  if (!editing.value) return
  mutate((payload) => {
    const source = payload.widgets.find((widget) => widget.id === id)
    if (!source) return
    const copy = clone(source)
    copy.id = createId('home-widget')
    copy.layout.desktop.y = bottomRow(payload.widgets)
    payload.widgets.push(copy)
  })
}

function removeWidget(id: string): void {
  if (!editing.value) beginEdit()
  if (!editing.value) return
  mutate((payload) => {
    payload.widgets = payload.widgets.filter((widget) => widget.id !== id)
  })
}

function resizeWidget(
  id: string,
  size: { w: number; h: number },
  target: 'desktop' | 'compact' = 'desktop',
): void {
  if (!editing.value) beginEdit()
  if (!editing.value) return
  mutate((payload) => {
    const widget = payload.widgets.find((candidate) => candidate.id === id)
    if (!widget) return
    const columns = target === 'compact' ? 6 : 12
    const width = Math.max(1, Math.min(Math.round(size.w), columns))
    const height = Math.max(1, Math.round(size.h))
    const current =
      widget.layout[target] ??
      ({
        ...widget.layout.desktop,
        x: 0,
        w: Math.min(widget.layout.desktop.w, columns),
      } satisfies InformationHomeGridPosition)
    widget.layout[target] = {
      ...current,
      x: Math.min(current.x, columns - width),
      w: width,
      h: height,
      minW: Math.min(current.minW ?? 1, width),
      minH: Math.min(current.minH ?? 1, height),
    }
  })
}

function updateWidgetSettings(id: string, settings: InformationHomeWidget['settings']): void {
  if (!home.value || editing.value) return
  error.value = ''
  const next = clone(draft.value)
  const widget = next.widgets.find((candidate) => candidate.id === id)
  if (!widget) return
  widget.settings = clone(settings)
  draft.value = next
  const queuedPayload = clone(next)
  pendingSettingsSaves += 1
  pendingWidgetSettingsSaves.set(id, (pendingWidgetSettingsSaves.get(id) ?? 0) + 1)
  settingsSaving.value = true
  setWidgetSettingsState(id, 'saving')
  settingsSaveQueue = settingsSaveQueue
    .then(() => persistWidgetSettings(queuedPayload))
    .then((saved) => {
      const remaining = Math.max(0, (pendingWidgetSettingsSaves.get(id) ?? 1) - 1)
      if (remaining > 0) {
        pendingWidgetSettingsSaves.set(id, remaining)
        setWidgetSettingsState(id, 'saving')
      } else {
        pendingWidgetSettingsSaves.delete(id)
        setWidgetSettingsState(id, saved ? 'saved' : 'error')
      }
    })
    .finally(() => {
      pendingSettingsSaves -= 1
      settingsSaving.value = pendingSettingsSaves > 0
    })
}

function setWidgetSettingsState(id: string, state: PersistenceState): void {
  const timer = widgetFeedbackTimers.get(id)
  if (timer != null) {
    globalThis.clearTimeout(timer)
    widgetFeedbackTimers.delete(id)
  }
  widgetSettingsStates.value = { ...widgetSettingsStates.value, [id]: state }
  if (state !== 'saved') return
  widgetFeedbackTimers.set(
    id,
    globalThis.setTimeout(() => {
      if (widgetSettingsStates.value[id] === 'saved') {
        widgetSettingsStates.value = { ...widgetSettingsStates.value, [id]: 'idle' }
      }
      widgetFeedbackTimers.delete(id)
    }, 1800),
  )
}

async function persistWidgetSettings(payload: InformationHomePayload): Promise<boolean> {
  if (!home.value) return false
  try {
    const result = await (await service()).savePayload(home.value, payload)
    if (!result.ok) {
      error.value = result.error.message
      draft.value = clone(home.value.payload)
      return false
    }
    home.value = result.value
    if (JSON.stringify(draft.value) === JSON.stringify(payload)) {
      draft.value = clone(result.value.payload)
    }
    return true
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
    draft.value = clone(home.value.payload)
    return false
  }
}

function updateLayout(
  positions: Record<string, InformationHomeGridPosition>,
  target: 'desktop' | 'compact',
): void {
  if (!editing.value) return
  const current = JSON.stringify(draft.value.widgets.map((widget) => widget.layout[target]))
  const next = JSON.stringify(
    draft.value.widgets.map((widget) => positions[widget.id] ?? widget.layout[target]),
  )
  if (current === next) return
  mutate((payload) => {
    payload.widgets = payload.widgets.map((widget) => ({
      ...widget,
      layout: { ...widget.layout, [target]: positions[widget.id] ?? widget.layout[target] },
    }))
  })
}

async function generateSummary(trigger: 'manual' | 'auto' = 'manual'): Promise<void> {
  if (generatingSummary.value) return
  generatingSummary.value = true
  error.value = ''
  try {
    const loaded = await props.ensureAiSecretLoaded()
    if (!loaded) throw new Error('AI 凭据尚未加载，请先在设置中完成 Provider 配置。')
    await publishSignalRefresh({
      since: latestSummary.value?.sourceCursorAt ?? Date.now() - 24 * 60 * 60 * 1_000,
      triggerSource: trigger === 'manual' ? 'manual' : 'connector',
    })
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
    const summaryResult = await (await service()).listSummaries(20)
    if (summaryResult.ok) summaries.value = summaryResult.value
  } finally {
    generatingSummary.value = false
  }
}

async function toggleAutoSummary(): Promise<void> {
  if (!home.value || summarySettingsState.value === 'saving') return
  await persistSummarySettings(!home.value.autoSummaryEnabled, home.value.summaryIntervalMinutes)
}

async function changeSummaryInterval(): Promise<void> {
  if (!home.value || summarySettingsState.value === 'saving') return
  const value = globalThis.prompt(
    '自动摘要最短间隔（分钟，30–10080）',
    String(home.value.summaryIntervalMinutes),
  )
  if (value == null) return
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return void (error.value = '请输入有效的分钟数。')
  await persistSummarySettings(home.value.autoSummaryEnabled, minutes)
}

async function persistSummarySettings(enabled: boolean, minutes: number): Promise<void> {
  if (!home.value) return
  if (summaryFeedbackTimer != null) {
    globalThis.clearTimeout(summaryFeedbackTimer)
    summaryFeedbackTimer = null
  }
  summarySettingsState.value = 'saving'
  error.value = ''
  try {
    const result = await (await service()).updateSummarySettings(enabled, minutes)
    if (!result.ok) {
      error.value = result.error.message
      summarySettingsState.value = 'error'
      return
    }
    home.value = result.value
    summarySettingsState.value = 'saved'
    summaryFeedbackTimer = globalThis.setTimeout(() => {
      if (summarySettingsState.value === 'saved') summarySettingsState.value = 'idle'
      summaryFeedbackTimer = null
    }, 1800)
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
    summarySettingsState.value = 'error'
  }
}

function createWidget(
  type: InformationHomeWidgetType,
  widgets: InformationHomeWidget[],
): InformationHomeWidget {
  const size = getInformationHomeWidgetDefinition(type).defaultSize
  return {
    id: createId('home-widget'),
    widgetType: type,
    widgetVersion: 1,
    query: { limit: type === 'agent-summary' ? 1 : 8 },
    settings: {},
    layout: { desktop: { x: 0, y: bottomRow(widgets), ...size } },
  }
}

function bottomRow(widgets: InformationHomeWidget[]): number {
  return widgets.reduce(
    (bottom, widget) => Math.max(bottom, widget.layout.desktop.y + widget.layout.desktop.h),
    0,
  )
}

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

onMounted(async () => {
  await load()
  if (canListenToTauriEvents)
    unlistenSignalAgent = await listen<{
      latestUpdateAt?: number
      queuedCount?: number
      runningCount?: number
      toolName?: string
    }>('signal-agent://changed', ({ payload }) => {
      if (typeof payload.queuedCount === 'number' && typeof payload.runningCount === 'number')
        generatingSummary.value = payload.queuedCount + payload.runningCount > 0
      if (payload.toolName) {
        if (HOME_MUTATION_TOOLS.has(payload.toolName)) scheduleSilentRefresh()
        return
      }
      if (!payload.latestUpdateAt || payload.latestUpdateAt === lastSignalUpdateAt) return
      lastSignalUpdateAt = payload.latestUpdateAt
      scheduleSilentRefresh()
    })
})
onBeforeUnmount(() => {
  if (silentRefreshTimer != null) globalThis.clearTimeout(silentRefreshTimer)
  if (summaryFeedbackTimer != null) globalThis.clearTimeout(summaryFeedbackTimer)
  widgetFeedbackTimers.forEach((timer) => globalThis.clearTimeout(timer))
  widgetFeedbackTimers.clear()
  unlistenSignalAgent?.()
})
</script>

<template>
  <section
    class="dashboard-surface information-home-surface"
    :class="{ 'dashboard-surface--editing': editing }"
    aria-label="首页信息面板"
    @click="closeContextMenu"
    @contextmenu.prevent="openContextMenu"
  >
    <p v-if="!native" class="dashboard-widget-state">独立首页数据需要在 Tauri 桌面应用中读取。</p>
    <p v-else-if="loading" class="dashboard-widget-state">正在加载信息首页…</p>
    <p v-if="error" class="information-home-surface__error" role="alert">{{ error }}</p>
    <div
      v-if="native && !loading && showMenu"
      class="information-home-menu__popover"
      role="menu"
      aria-label="信息面板右键菜单"
      :style="{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button
        v-if="!editing"
        type="button"
        role="menuitem"
        class="information-home-menu__entry"
        :disabled="settingsSaving"
        @mouseenter="activeSubmenu = null"
        @click="beginEdit"
      >
        <Pencil :size="15" /><span><strong>编辑布局</strong></span>
      </button>
      <div class="information-home-menu__submenu-host" @mouseenter="activeSubmenu = 'add'">
        <button
          type="button"
          role="menuitem"
          class="information-home-menu__entry"
          aria-haspopup="menu"
          :aria-expanded="activeSubmenu === 'add'"
          :disabled="settingsSaving"
          @click="activeSubmenu = activeSubmenu === 'add' ? null : 'add'"
        >
          <Plus :size="15" /><span><strong>添加卡片</strong></span
          ><ChevronRight :size="14" />
        </button>
        <div
          v-if="activeSubmenu === 'add'"
          class="information-home-menu__submenu"
          role="menu"
          aria-label="添加卡片"
        >
          <button
            v-for="definition in INFORMATION_HOME_WIDGET_REGISTRY"
            :key="definition.type"
            type="button"
            role="menuitem"
            class="information-home-menu__entry"
            @click="addWidgetFromMenu(definition.type)"
          >
            <span
              ><strong>{{ definition.title }}</strong
              ><small>{{ definition.description }}</small></span
            >
          </button>
        </div>
      </div>
      <div
        v-if="editing"
        class="information-home-menu__submenu-host"
        @mouseenter="activeSubmenu = 'layout'"
      >
        <button
          type="button"
          role="menuitem"
          class="information-home-menu__entry"
          aria-haspopup="menu"
          :aria-expanded="activeSubmenu === 'layout'"
          @click="activeSubmenu = activeSubmenu === 'layout' ? null : 'layout'"
        >
          <Undo2 :size="15" /><span><strong>布局操作</strong></span
          ><ChevronRight :size="14" />
        </button>
        <div
          v-if="activeSubmenu === 'layout'"
          class="information-home-menu__submenu"
          role="menu"
          aria-label="布局操作"
        >
          <button
            type="button"
            role="menuitem"
            class="information-home-menu__entry"
            :disabled="!undoStack.length"
            @click="undoFromMenu"
          >
            <Undo2 :size="15" /><span><strong>撤销</strong></span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="information-home-menu__entry"
            @click="resetFromMenu"
          >
            <RotateCcw :size="15" /><span><strong>恢复默认</strong></span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="native && !loading" class="dashboard-surface__workspace">
      <InformationHomeGrid
        :widgets="draft.widgets"
        :editing="editing"
        :summaries="summaries"
        :rss-summary="latestRssSummary"
        :generating-summary="generatingSummary"
        :auto-summary-enabled="home?.autoSummaryEnabled ?? false"
        :summary-interval-minutes="home?.summaryIntervalMinutes ?? 360"
        :widget-settings-states="widgetSettingsStates"
        :summary-settings-state="summarySettingsState"
        @layout="updateLayout"
        @copy="copyWidget"
        @remove="removeWidget"
        @open-email="emit('openInbox', 'email', $event)"
        @open-rss="emit('openInbox', 'rss', $event)"
        @generate-summary="generateSummary('manual')"
        @toggle-auto-summary="toggleAutoSummary"
        @change-summary-interval="changeSummaryInterval"
        @resize="resizeWidget"
        @update-settings="updateWidgetSettings"
      />
    </div>
    <div v-if="native && !loading && editing" class="information-home-controls is-editing">
      <button type="button" @click="cancelEdit"><X :size="16" />取消</button>
      <button type="button" class="is-primary" :disabled="!dirty || saving" @click="save">
        <Check :size="16" />{{ saving ? '保存中' : '保存布局' }}
      </button>
    </div>
  </section>
</template>
