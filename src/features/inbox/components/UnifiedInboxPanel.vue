<script setup lang="ts">
import {
  Archive,
  Check,
  ExternalLink,
  FileText,
  Mail,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Rss,
} from '@lucide/vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { createDingTalkService } from '@/app/composition/dingTalkServiceFactory'
import { createEmailService } from '@/app/composition/emailServiceFactory'
import { createRssService } from '@/app/composition/rssServiceFactory'
import type { EmailAccount, EmailMessage, EmailProcessingStatus } from '@/models/inbox/email'
import type { RssEntry, RssProcessingStatus, RssSource } from '@/models/inbox/rss'
import type { ImConnector, ImMessage, ImProcessingStatus } from '@/models/inbox/im'
import type { DingTalkService } from '@/services/inbox/DingTalkService'
import type { EmailService } from '@/services/inbox/EmailService'
import type { RssService } from '@/services/inbox/RssService'
import { useMessage } from '@/ui/services'

type UnifiedStatus = EmailProcessingStatus | RssProcessingStatus | ImProcessingStatus
type UnifiedItem =
  | {
      kind: 'email'
      id: string
      timestamp: number
      source: string
      category: string
      author: string
      title: string
      preview: string
      status: UnifiedStatus
      payload: EmailMessage
    }
  | {
      kind: 'rss'
      id: string
      timestamp: number
      source: string
      category: string
      author: string
      title: string
      preview: string
      status: UnifiedStatus
      payload: RssEntry
    }
  | {
      kind: 'im'
      id: string
      timestamp: number
      source: string
      category: string
      author: string
      title: string
      preview: string
      status: UnifiedStatus
      payload: ImMessage
    }

const props = defineProps<{ mode: 'pending' | 'all' }>()
const emit = defineEmits<{ openConnections: [] }>()
const notify = useMessage()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const accounts = ref<EmailAccount[]>([])
const sources = ref<RssSource[]>([])
const emails = ref<EmailMessage[]>([])
const rssEntries = ref<RssEntry[]>([])
const imConnectors = ref<ImConnector[]>([])
const imMessages = ref<ImMessage[]>([])
const selectedId = ref('')
const loading = ref(false)
const syncing = ref(false)
const categoryFilter = ref('all')
const extractingId = ref('')
const error = ref('')
let emailPromise: Promise<EmailService> | null = null
let rssPromise: Promise<RssService> | null = null
let imPromise: Promise<DingTalkService> | null = null
let unlisten: UnlistenFn | null = null

const emailService = () => (emailPromise ??= createEmailService())
const rssService = () => (rssPromise ??= createRssService())
const imService = () => (imPromise ??= createDingTalkService())
const allItems = computed<UnifiedItem[]>(() =>
  [
    ...emails.value.map(
      (message): UnifiedItem => ({
        kind: 'email',
        id: `email:${message.id}`,
        timestamp: message.receivedAt,
        source:
          accounts.value.find((account) => account.id === message.accountId)?.displayName ?? '邮箱',
        category:
          accounts.value.find((account) => account.id === message.accountId)?.sourceCategory ??
          '未分类',
        author: message.fromName || message.fromAddress || '未知发件人',
        title: message.subject,
        preview: message.preview,
        status: message.processingStatus,
        payload: message,
      }),
    ),
    ...rssEntries.value.map(
      (entry): UnifiedItem => ({
        kind: 'rss',
        id: `rss:${entry.id}`,
        timestamp: entry.publishedAt,
        source: sources.value.find((source) => source.id === entry.sourceId)?.displayName ?? 'RSS',
        category:
          sources.value.find((source) => source.id === entry.sourceId)?.sourceCategory ?? '未分类',
        author: entry.author || 'RSS 来源',
        title: entry.title,
        preview: entry.preview,
        status: entry.processingStatus,
        payload: entry,
      }),
    ),
    ...imMessages.value.map(
      (message): UnifiedItem => ({
        kind: 'im',
        id: `im:${message.id}`,
        timestamp: message.sentAt,
        source:
          imConnectors.value.find((connector) => connector.id === message.connectorId)
            ?.displayName ?? '钉钉',
        category:
          imConnectors.value.find((connector) => connector.id === message.connectorId)
            ?.sourceCategory ?? '未分类',
        author: message.senderName || '钉钉用户',
        title: message.conversationTitle,
        preview: message.bodyText,
        status: message.processingStatus,
        payload: message,
      }),
    ),
  ].sort((left, right) => right.timestamp - left.timestamp),
)
const items = computed(() =>
  categoryFilter.value === 'all'
    ? allItems.value
    : allItems.value.filter((item) => item.category === categoryFilter.value),
)
const categoryOptions = computed(() => [
  'all',
  ...new Set(
    [...accounts.value, ...sources.value, ...imConnectors.value].map(
      (source) => source.sourceCategory,
    ),
  ),
])
const selected = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null)
const pendingCount = computed(() => items.value.filter((item) => item.status === 'pending').length)
const latestSyncAt = computed(() =>
  [...accounts.value, ...sources.value].reduce<number | null>(
    (latest, source) =>
      source.lastSyncedAt && (!latest || source.lastSyncedAt > latest)
        ? source.lastSyncedAt
        : latest,
    null,
  ),
)
const latestCursorAt = computed(() =>
  [...accounts.value, ...sources.value].reduce<number | null>(
    (latest, source) =>
      source.syncCursorAt && (!latest || source.syncCursorAt > latest)
        ? source.syncCursorAt
        : latest,
    null,
  ),
)
const latestStreamAt = computed(() =>
  imConnectors.value.reduce<number | null>(
    (latest, connector) =>
      connector.lastEventAt && (!latest || connector.lastEventAt > latest)
        ? connector.lastEventAt
        : latest,
    null,
  ),
)

async function load(showLoading = true): Promise<void> {
  if (!native) return
  if (showLoading) loading.value = true
  error.value = ''
  const [email, rss, im] = await Promise.all([emailService(), rssService(), imService()])
  const status = props.mode === 'pending' ? 'pending' : undefined
  const [accountResult, sourceResult, connectorResult, emailResult, rssResult, imResult] =
    await Promise.all([
      email.listAccounts(),
      rss.listSources(),
      im.listConnectors(),
      email.listMessages({ status, limit: 200 }),
      rss.listEntries({ status, limit: 200 }),
      im.listMessages({ status, limit: 200 }),
    ])
  if (showLoading) loading.value = false
  const failed = [
    accountResult,
    sourceResult,
    connectorResult,
    emailResult,
    rssResult,
    imResult,
  ].find((result) => !result.ok)
  if (failed && !failed.ok) return void (error.value = failed.error.message)
  if (
    !accountResult.ok ||
    !sourceResult.ok ||
    !connectorResult.ok ||
    !emailResult.ok ||
    !rssResult.ok ||
    !imResult.ok
  )
    return
  accounts.value = accountResult.value
  sources.value = sourceResult.value
  imConnectors.value = connectorResult.value
  emails.value = emailResult.value
  rssEntries.value = rssResult.value
  imMessages.value = imResult.value
  if (!items.value.some((item) => item.id === selectedId.value))
    selectedId.value = items.value[0]?.id ?? ''
}

async function syncAll(): Promise<void> {
  syncing.value = true
  error.value = ''
  let imported = 0
  let syncError = ''
  try {
    const email = await emailService()
    const rss = await rssService()
    for (const account of accounts.value) {
      const result = await email.syncAccount(account)
      if (result.ok) imported += result.value
      else syncError = result.error.message
    }
    for (const source of sources.value) {
      const result = await rss.syncSource(source)
      if (result.ok) imported += result.value
      else syncError = result.error.message
    }
    await load()
    if (syncError) error.value = syncError
    else notify.success(imported ? `统一收件箱已读取 ${imported} 条更新` : '所有来源已是最新状态')
  } finally {
    syncing.value = false
  }
}

async function setStatus(item: UnifiedItem, status: UnifiedStatus): Promise<void> {
  const result =
    item.kind === 'email'
      ? await (await emailService()).setMessageStatus(item.payload.id, status)
      : item.kind === 'rss'
        ? await (await rssService()).setEntryStatus(item.payload.id, status)
        : await (await imService()).setMessageStatus(item.payload.id, status)
  if (!result.ok) return void (error.value = result.error.message)
  await load()
}

async function openOriginal(item: UnifiedItem): Promise<void> {
  if (item.kind !== 'rss' || !item.payload.articleUrl) return
  try {
    await openUrl(item.payload.articleUrl)
  } catch (openError) {
    error.value = openError instanceof Error ? openError.message : String(openError)
  }
}

async function extractArticle(item: UnifiedItem): Promise<void> {
  if (item.kind !== 'rss') return
  extractingId.value = item.payload.id
  error.value = ''
  try {
    const result = await (await rssService()).extractArticle(item.payload)
    if (!result.ok) return void (error.value = result.error.message)
    rssEntries.value = rssEntries.value.map((entry) =>
      entry.id === item.payload.id ? result.value : entry,
    )
    notify.success('已从文章页提取正文')
  } finally {
    extractingId.value = ''
  }
}

function processingLabel(status: UnifiedStatus): string {
  return status === 'done' ? '已处理' : status === 'archived' ? '已归档' : '待处理'
}
function formatListTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
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

onMounted(async () => {
  await load()
  if (native) unlisten = await listen('dingtalk-message-received', () => void load(false))
})
onBeforeUnmount(() => unlisten?.())
watch(
  () => props.mode,
  () => void load(),
)
watch(categoryFilter, () => {
  selectedId.value = items.value[0]?.id ?? ''
})
</script>

<template>
  <section class="email-inbox-panel unified-inbox-panel" aria-label="统一收件箱">
    <header class="email-inbox-panel__toolbar">
      <div class="email-inbox-panel__metrics" aria-label="收件箱统计">
        <div>
          <strong>{{ items.length }}</strong
          ><span>全部动态</span>
        </div>
        <div>
          <strong>{{ pendingCount }}</strong
          ><span>待处理</span>
        </div>
        <div>
          <strong>{{ accounts.length + sources.length + imConnectors.length }}</strong
          ><span>信息来源</span>
        </div>
      </div>
      <div class="email-inbox-panel__sync">
        <span v-if="latestSyncAt"
          >CHECK · {{ formatFullTime(latestSyncAt)
          }}<template v-if="latestCursorAt">
            / CONTENT · {{ formatFullTime(latestCursorAt) }}</template
          ></span
        ><span v-else-if="latestStreamAt">STREAM · {{ formatFullTime(latestStreamAt) }}</span
        ><span v-else>尚未收到或同步内容</span>
        <button
          type="button"
          :disabled="syncing || (!accounts.length && !sources.length)"
          @click="syncAll"
        >
          <RefreshCw :class="{ 'is-spinning': syncing }" :size="15" />{{
            syncing ? '同步中' : '同步全部'
          }}
        </button>
      </div>
    </header>
    <p v-if="error" class="email-inbox-panel__error" role="alert">{{ error }}</p>
    <nav v-if="categoryOptions.length > 2" class="inbox-source-filters" aria-label="统一来源分类">
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
    <div v-if="loading" class="inbox-empty-state"><span>正在读取统一收件箱…</span></div>
    <div
      v-else-if="!accounts.length && !sources.length && !imConnectors.length"
      class="inbox-empty-state"
    >
      <h2>还没有信息来源</h2>
      <p>先连接钉钉、邮箱或添加 RSS 订阅。</p>
      <button type="button" @click="emit('openConnections')">配置连接器</button>
    </div>
    <div v-else-if="!items.length" class="inbox-empty-state">
      <h2>{{ mode === 'pending' ? '没有待处理信息' : '暂时没有动态' }}</h2>
      <p>点击同步全部检查邮件和 RSS；钉钉消息会在应用在线时实时进入。</p>
    </div>
    <div v-else class="email-inbox-layout unified-inbox-layout">
      <div class="email-message-list unified-inbox-list" role="listbox" aria-label="统一动态列表">
        <button
          v-for="(item, index) in items"
          :key="item.id"
          type="button"
          role="option"
          :aria-selected="selectedId === item.id"
          :class="{ 'is-active': selectedId === item.id }"
          @click="selectedId = item.id"
        >
          <span class="email-message-list__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="email-message-list__content">
            <span class="email-message-list__sender"
              ><strong
                ><component
                  :is="item.kind === 'email' ? Mail : item.kind === 'rss' ? Rss : MessageCircle"
                  :size="11"
                />{{ item.source }}</strong
              ><time>{{ formatListTime(item.timestamp) }}</time></span
            >
            <span class="email-message-list__subject">{{ item.title }}</span
            ><span class="email-message-list__preview">{{ item.preview }}</span>
            <span class="email-message-list__footer"
              ><small :data-status="item.status">{{ processingLabel(item.status) }}</small
              ><span>{{
                item.kind === 'email' ? 'EMAIL' : item.kind === 'rss' ? 'RSS' : 'IM'
              }}</span
              ><span>{{ item.category }}</span
              ><span>{{ item.author }}</span></span
            >
          </span>
        </button>
      </div>
      <article v-if="selected" class="email-message-detail unified-inbox-detail">
        <header>
          <div>
            <span>{{ selected.kind.toUpperCase() }} / {{ selected.source }}</span>
            <h2>{{ selected.title }}</h2>
            <div class="email-message-detail__sender">
              <span
                ><component
                  :is="
                    selected.kind === 'email' ? Mail : selected.kind === 'rss' ? Rss : MessageCircle
                  "
                  :size="15"
              /></span>
              <p>
                <strong>{{ selected.author }}</strong
                ><small>{{ selected.source }}</small>
              </p>
            </div>
          </div>
          <div class="email-message-detail__actions">
            <button
              v-if="selected.kind === 'rss' && selected.payload.articleUrl"
              type="button"
              :disabled="extractingId === selected.payload.id"
              @click="extractArticle(selected)"
            >
              <FileText :size="14" />{{
                extractingId === selected.payload.id
                  ? '提取中'
                  : selected.payload.contentSource === 'article'
                    ? '重新提取全文'
                    : '提取全文'
              }}
            </button>
            <button
              v-if="selected.kind === 'rss' && selected.payload.articleUrl"
              type="button"
              @click="openOriginal(selected)"
            >
              <ExternalLink :size="14" />打开原文</button
            ><button
              v-if="selected.status !== 'pending'"
              type="button"
              @click="setStatus(selected, 'pending')"
            >
              <RotateCcw :size="14" />恢复待处理</button
            ><button
              v-if="selected.status !== 'done'"
              type="button"
              @click="setStatus(selected, 'done')"
            >
              <Check :size="14" />标记已处理</button
            ><button
              v-if="selected.status !== 'archived'"
              type="button"
              @click="setStatus(selected, 'archived')"
            >
              <Archive :size="14" />归档
            </button>
          </div>
        </header>
        <dl>
          <dt>类型</dt>
          <dd>
            {{ selected.kind === 'email' ? '邮件' : selected.kind === 'rss' ? 'RSS' : '钉钉消息' }}
          </dd>
          <dt>状态</dt>
          <dd>
            <span class="email-message-detail__status" :data-status="selected.status">{{
              processingLabel(selected.status)
            }}</span>
          </dd>
          <dt>来源</dt>
          <dd>{{ selected.source }}</dd>
          <dt>分类</dt>
          <dd>{{ selected.category }}</dd>
          <dt>时间</dt>
          <dd>{{ formatFullTime(selected.timestamp) }}</dd>
          <template v-if="selected.kind === 'rss'">
            <dt>正文来源</dt>
            <dd>
              {{
                selected.payload.contentSource === 'article'
                  ? '文章页全文'
                  : selected.payload.contentSource === 'feed'
                    ? 'RSS 正文'
                    : 'RSS 摘要'
              }}
            </dd>
          </template>
        </dl>
        <p
          v-if="selected.kind === 'rss' && selected.payload.articleFetchError"
          class="email-inbox-panel__error"
          role="status"
        >
          自动提取未完成：{{ selected.payload.articleFetchError }}
        </p>
        <section class="email-message-detail__body">
          <header><span>CONTENT</span><small>安全纯文本</small></header>
          <pre>{{ selected.payload.bodyText || selected.preview || '正文为空。' }}</pre>
        </section>
      </article>
    </div>
  </section>
</template>
