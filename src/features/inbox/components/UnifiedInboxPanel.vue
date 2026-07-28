<script setup lang="ts">
import { Archive, Check, ExternalLink, Mail, RefreshCw, RotateCcw, Rss } from '@lucide/vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { computed, onMounted, ref, watch } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import { createRssService } from '@/app/composition/rssServiceFactory'
import type { EmailAccount, EmailMessage, EmailProcessingStatus } from '@/models/inbox/email'
import type { RssEntry, RssProcessingStatus, RssSource } from '@/models/inbox/rss'
import type { EmailService } from '@/services/inbox/EmailService'
import type { RssService } from '@/services/inbox/RssService'
import { useMessage } from '@/ui/services'

type UnifiedStatus = EmailProcessingStatus | RssProcessingStatus
type UnifiedItem =
  | {
      kind: 'email'
      id: string
      timestamp: number
      source: string
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
      author: string
      title: string
      preview: string
      status: UnifiedStatus
      payload: RssEntry
    }

const props = defineProps<{ mode: 'pending' | 'all' }>()
const emit = defineEmits<{ openConnections: [] }>()
const notify = useMessage()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const accounts = ref<EmailAccount[]>([])
const sources = ref<RssSource[]>([])
const emails = ref<EmailMessage[]>([])
const rssEntries = ref<RssEntry[]>([])
const selectedId = ref('')
const loading = ref(false)
const syncing = ref(false)
const error = ref('')
let emailPromise: Promise<EmailService> | null = null
let rssPromise: Promise<RssService> | null = null

const emailService = () => (emailPromise ??= createEmailService())
const rssService = () => (rssPromise ??= createRssService())
const items = computed<UnifiedItem[]>(() =>
  [
    ...emails.value.map(
      (message): UnifiedItem => ({
        kind: 'email',
        id: `email:${message.id}`,
        timestamp: message.receivedAt,
        source:
          accounts.value.find((account) => account.id === message.accountId)?.displayName ?? '邮箱',
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
        author: entry.author || 'RSS 来源',
        title: entry.title,
        preview: entry.preview,
        status: entry.processingStatus,
        payload: entry,
      }),
    ),
  ].sort((left, right) => right.timestamp - left.timestamp),
)
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

async function load(): Promise<void> {
  if (!native) return
  loading.value = true
  error.value = ''
  const [email, rss] = await Promise.all([emailService(), rssService()])
  const status = props.mode === 'pending' ? 'pending' : undefined
  const [accountResult, sourceResult, emailResult, rssResult] = await Promise.all([
    email.listAccounts(),
    rss.listSources(),
    email.listMessages({ status, limit: 200 }),
    rss.listEntries({ status, limit: 200 }),
  ])
  loading.value = false
  const failed = [accountResult, sourceResult, emailResult, rssResult].find((result) => !result.ok)
  if (failed && !failed.ok) return void (error.value = failed.error.message)
  if (!accountResult.ok || !sourceResult.ok || !emailResult.ok || !rssResult.ok) return
  accounts.value = accountResult.value
  sources.value = sourceResult.value
  emails.value = emailResult.value
  rssEntries.value = rssResult.value
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
      : await (await rssService()).setEntryStatus(item.payload.id, status)
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

onMounted(() => void load())
watch(
  () => props.mode,
  () => void load(),
)
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
          <strong>{{ accounts.length + sources.length }}</strong
          ><span>信息来源</span>
        </div>
      </div>
      <div class="email-inbox-panel__sync">
        <span v-if="latestSyncAt">LAST SYNC · {{ formatFullTime(latestSyncAt) }}</span
        ><span v-else>尚未完成同步</span>
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
    <div v-if="loading" class="inbox-empty-state"><span>正在读取统一收件箱…</span></div>
    <div v-else-if="!accounts.length && !sources.length" class="inbox-empty-state">
      <h2>还没有信息来源</h2>
      <p>先连接邮箱或添加 RSS 订阅。</p>
      <button type="button" @click="emit('openConnections')">配置连接器</button>
    </div>
    <div v-else-if="!items.length" class="inbox-empty-state">
      <h2>{{ mode === 'pending' ? '没有待处理信息' : '暂时没有动态' }}</h2>
      <p>点击同步全部检查邮件和 RSS 更新。</p>
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
                ><component :is="item.kind === 'email' ? Mail : Rss" :size="11" />{{
                  item.source
                }}</strong
              ><time>{{ formatListTime(item.timestamp) }}</time></span
            >
            <span class="email-message-list__subject">{{ item.title }}</span
            ><span class="email-message-list__preview">{{ item.preview }}</span>
            <span class="email-message-list__footer"
              ><small :data-status="item.status">{{ processingLabel(item.status) }}</small
              ><span>{{ item.kind === 'email' ? 'EMAIL' : 'RSS' }}</span
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
              <span><component :is="selected.kind === 'email' ? Mail : Rss" :size="15" /></span>
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
          <dd>{{ selected.kind === 'email' ? '邮件' : 'RSS' }}</dd>
          <dt>状态</dt>
          <dd>
            <span class="email-message-detail__status" :data-status="selected.status">{{
              processingLabel(selected.status)
            }}</span>
          </dd>
          <dt>来源</dt>
          <dd>{{ selected.source }}</dd>
          <dt>时间</dt>
          <dd>{{ formatFullTime(selected.timestamp) }}</dd>
        </dl>
        <section class="email-message-detail__body">
          <header><span>CONTENT</span><small>安全纯文本</small></header>
          <pre>{{ selected.payload.bodyText || selected.preview || '正文为空。' }}</pre>
        </section>
      </article>
    </div>
  </section>
</template>
