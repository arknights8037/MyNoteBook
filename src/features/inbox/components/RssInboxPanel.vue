<script setup lang="ts">
import {
  Archive,
  Check,
  ExternalLink,
  FileText,
  Inbox,
  RefreshCw,
  RotateCcw,
  Rss,
} from '@lucide/vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { computed, onMounted, ref, watch } from 'vue'

import { createRssService } from '@/app/composition/rssServiceFactory'
import type { RssEntry, RssProcessingStatus, RssSource } from '@/models/inbox/rss'
import type { RssService } from '@/services/inbox/RssService'
import { useMessage } from '@/ui/services'

const props = defineProps<{ mode: 'pending' | 'all' | 'rss' }>()
const emit = defineEmits<{ openConnections: [] }>()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const sources = ref<RssSource[]>([])
const entries = ref<RssEntry[]>([])
const selectedId = ref('')
const loading = ref(false)
const syncing = ref(false)
const categoryFilter = ref('all')
const extractingId = ref('')
const error = ref('')
let servicePromise: Promise<RssService> | null = null

const service = () => (servicePromise ??= createRssService())
const visibleEntries = computed(() =>
  categoryFilter.value === 'all'
    ? entries.value
    : entries.value.filter(
        (entry) =>
          sources.value.find((source) => source.id === entry.sourceId)?.sourceCategory ===
          categoryFilter.value,
      ),
)
const categoryOptions = computed(() => [
  'all',
  ...new Set(sources.value.map((source) => source.sourceCategory)),
])
const selected = computed(
  () => visibleEntries.value.find((entry) => entry.id === selectedId.value) ?? null,
)
const selectedSource = computed(
  () => sources.value.find((source) => source.id === selected.value?.sourceId) ?? null,
)
const pendingCount = computed(
  () => visibleEntries.value.filter((entry) => entry.processingStatus === 'pending').length,
)
const latestSyncAt = computed(() =>
  sources.value.reduce<number | null>(
    (latest, source) =>
      source.lastSyncedAt && (!latest || source.lastSyncedAt > latest)
        ? source.lastSyncedAt
        : latest,
    null,
  ),
)
const latestCursorAt = computed(() =>
  sources.value.reduce<number | null>(
    (latest, source) =>
      source.syncCursorAt && (!latest || source.syncCursorAt > latest)
        ? source.syncCursorAt
        : latest,
    null,
  ),
)

async function load(): Promise<void> {
  if (!native) return
  loading.value = true
  error.value = ''
  const [sourceResult, entryResult] = await Promise.all([
    (await service()).listSources(),
    (await service()).listEntries({
      status: props.mode === 'pending' ? 'pending' : undefined,
      limit: 200,
    }),
  ])
  loading.value = false
  if (!sourceResult.ok) return void (error.value = sourceResult.error.message)
  if (!entryResult.ok) return void (error.value = entryResult.error.message)
  sources.value = sourceResult.value
  entries.value = entryResult.value
  if (!visibleEntries.value.some((entry) => entry.id === selectedId.value))
    selectedId.value = visibleEntries.value[0]?.id ?? ''
}

async function syncAll(): Promise<void> {
  syncing.value = true
  error.value = ''
  let imported = 0
  let syncError = ''
  try {
    for (const source of sources.value) {
      const result = await (await service()).syncSource(source)
      if (result.ok) imported += result.value
      else syncError = result.error.message
    }
    await load()
    if (syncError) error.value = syncError
    else notify.success(imported ? `RSS 同步完成，读取 ${imported} 条` : 'RSS 已是最新状态')
  } finally {
    syncing.value = false
  }
}

async function setStatus(entry: RssEntry, status: RssProcessingStatus): Promise<void> {
  const result = await (await service()).setEntryStatus(entry.id, status)
  if (!result.ok) return void (error.value = result.error.message)
  if (props.mode === 'pending' && status !== 'pending') {
    entries.value = entries.value.filter((candidate) => candidate.id !== entry.id)
    selectedId.value = entries.value[0]?.id ?? ''
  } else {
    entries.value = entries.value.map((candidate) =>
      candidate.id === entry.id ? result.value : candidate,
    )
  }
}

async function openOriginal(entry: RssEntry): Promise<void> {
  if (!entry.articleUrl) return
  try {
    await openUrl(entry.articleUrl)
  } catch (openError) {
    error.value = openError instanceof Error ? openError.message : String(openError)
  }
}

async function extractArticle(entry: RssEntry): Promise<void> {
  extractingId.value = entry.id
  error.value = ''
  try {
    const result = await (await service()).extractArticle(entry)
    if (!result.ok) return void (error.value = result.error.message)
    entries.value = entries.value.map((candidate) =>
      candidate.id === entry.id ? result.value : candidate,
    )
    notify.success('已从文章页提取正文')
  } finally {
    extractingId.value = ''
  }
}

function sourceName(sourceId: string): string {
  return sources.value.find((source) => source.id === sourceId)?.displayName ?? 'RSS'
}

function processingLabel(status: RssProcessingStatus): string {
  return status === 'done' ? '已处理' : status === 'archived' ? '已归档' : '待处理'
}

function contentSourceLabel(entry: RssEntry): string {
  return entry.contentSource === 'article'
    ? '文章页全文'
    : entry.contentSource === 'feed'
      ? 'RSS 正文'
      : 'RSS 摘要'
}

function formatListTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString())
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function formatFullTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

onMounted(() => void load())
watch(
  () => props.mode,
  () => void load(),
)
watch(categoryFilter, () => {
  selectedId.value = visibleEntries.value[0]?.id ?? ''
})
</script>

<template>
  <section class="email-inbox-panel rss-inbox-panel" aria-label="RSS 收件箱">
    <header class="email-inbox-panel__toolbar">
      <div class="email-inbox-panel__metrics" aria-label="RSS 统计">
        <div>
          <strong>{{ visibleEntries.length }}</strong
          ><span>当前载入</span>
        </div>
        <div>
          <strong>{{ pendingCount }}</strong
          ><span>待处理</span>
        </div>
        <div>
          <strong>{{ sources.length }}</strong
          ><span>订阅源</span>
        </div>
      </div>
      <div class="email-inbox-panel__sync">
        <span v-if="latestSyncAt"
          >CHECK · {{ formatFullTime(latestSyncAt)
          }}<template v-if="latestCursorAt">
            / CONTENT · {{ formatFullTime(latestCursorAt) }}</template
          ></span
        ><span v-else>尚未完成同步</span>
        <button type="button" :disabled="!native || syncing || !sources.length" @click="syncAll">
          <RefreshCw :class="{ 'is-spinning': syncing }" :size="15" />{{
            syncing ? '同步中' : '同步 RSS'
          }}
        </button>
      </div>
    </header>
    <p v-if="error" class="email-inbox-panel__error" role="alert">{{ error }}</p>
    <nav v-if="categoryOptions.length > 2" class="inbox-source-filters" aria-label="RSS 来源分类">
      <button
        v-for="category in categoryOptions"
        :key="category"
        type="button"
        :class="{ 'is-active': categoryFilter === category }"
        @click="categoryFilter = category"
      >
        {{ category === 'all' ? '全部来源' : category }}
      </button>
    </nav>
    <div v-if="loading" class="inbox-empty-state"><span>正在读取本地 RSS…</span></div>
    <div v-else-if="!sources.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Rss :size="25" /></span>
      <h2>先添加一个 RSS 订阅</h2>
      <p>订阅源在“连接与扩展”中配置，条目会回到这里阅读和处理。</p>
      <button type="button" @click="emit('openConnections')">添加订阅</button>
    </div>
    <div v-else-if="!visibleEntries.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Inbox :size="25" /></span>
      <h2>{{ mode === 'pending' ? '没有待处理 RSS' : '订阅源暂时没有条目' }}</h2>
      <p>点击同步检查更新；条件请求会避免重复下载未变化的订阅。</p>
    </div>
    <div v-else class="email-inbox-layout rss-inbox-layout">
      <div class="email-message-list rss-entry-list" role="listbox" aria-label="RSS 条目列表">
        <button
          v-for="(entry, index) in visibleEntries"
          :key="entry.id"
          type="button"
          role="option"
          :aria-selected="selectedId === entry.id"
          :class="{ 'is-active': selectedId === entry.id }"
          @click="selectedId = entry.id"
        >
          <span class="email-message-list__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="email-message-list__content">
            <span class="email-message-list__sender"
              ><strong>{{ sourceName(entry.sourceId) }}</strong
              ><time>{{ formatListTime(entry.publishedAt) }}</time></span
            >
            <span class="email-message-list__subject">{{ entry.title }}</span>
            <span class="email-message-list__preview">{{ entry.preview }}</span>
            <span class="email-message-list__footer"
              ><small :data-status="entry.processingStatus">{{
                processingLabel(entry.processingStatus)
              }}</small
              ><span v-if="entry.author">{{ entry.author }}</span
              ><span v-if="entry.categories.length">{{ entry.categories[0] }}</span></span
            >
          </span>
        </button>
      </div>
      <article v-if="selected" class="email-message-detail rss-entry-detail">
        <header>
          <div>
            <span>RSS / {{ selectedSource?.displayName || 'FEED' }}</span>
            <h2>{{ selected.title }}</h2>
            <div class="email-message-detail__sender">
              <span><Rss :size="15" /></span>
              <p>
                <strong>{{ selected.author || selectedSource?.displayName || 'RSS 来源' }}</strong
                ><small>{{ selectedSource?.siteUrl || selectedSource?.feedUrl }}</small>
              </p>
            </div>
          </div>
          <div class="email-message-detail__actions">
            <button
              v-if="selected.articleUrl"
              type="button"
              :disabled="extractingId === selected.id"
              @click="extractArticle(selected)"
            >
              <FileText :size="14" />{{
                extractingId === selected.id
                  ? '提取中'
                  : selected.contentSource === 'article'
                    ? '重新提取全文'
                    : '提取全文'
              }}
            </button>
            <button v-if="selected.articleUrl" type="button" @click="openOriginal(selected)">
              <ExternalLink :size="14" />打开原文
            </button>
            <button
              v-if="selected.processingStatus !== 'pending'"
              type="button"
              @click="setStatus(selected, 'pending')"
            >
              <RotateCcw :size="14" />恢复待处理
            </button>
            <button
              v-if="selected.processingStatus !== 'done'"
              type="button"
              @click="setStatus(selected, 'done')"
            >
              <Check :size="14" />标记已处理
            </button>
            <button
              v-if="selected.processingStatus !== 'archived'"
              type="button"
              @click="setStatus(selected, 'archived')"
            >
              <Archive :size="14" />归档
            </button>
          </div>
        </header>
        <dl>
          <dt>状态</dt>
          <dd>
            <span class="email-message-detail__status" :data-status="selected.processingStatus">{{
              processingLabel(selected.processingStatus)
            }}</span>
          </dd>
          <dt>来源</dt>
          <dd>{{ selectedSource?.displayName || 'RSS' }}</dd>
          <dt>作者</dt>
          <dd>{{ selected.author || '—' }}</dd>
          <dt>发布时间</dt>
          <dd>{{ formatFullTime(selected.publishedAt) }}</dd>
          <dt>分类</dt>
          <dd>{{ selected.categories.join(' · ') || '—' }}</dd>
          <dt>正文来源</dt>
          <dd>{{ contentSourceLabel(selected) }}</dd>
        </dl>
        <p v-if="selected.articleFetchError" class="email-inbox-panel__error" role="status">
          自动提取未完成：{{ selected.articleFetchError }}
        </p>
        <section class="email-message-detail__body">
          <header>
            <span>RSS CONTENT</span><small>{{ contentSourceLabel(selected) }} · 安全纯文本</small>
          </header>
          <pre>{{ selected.bodyText || selected.preview || '该条目没有正文。' }}</pre>
        </section>
      </article>
    </div>
  </section>
</template>
