<script setup lang="ts">
import { Archive, Check, Inbox, Mail, Paperclip, RefreshCw, RotateCcw } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import type { EmailAccount, EmailMessage, EmailProcessingStatus } from '@/models/inbox/email'
import type { EmailService } from '@/services/inbox/EmailService'
import { useMessage } from '@/ui/services'

const props = defineProps<{ mode: 'pending' | 'all' | 'email'; targetId?: string }>()
const emit = defineEmits<{ openConnections: [] }>()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const accounts = ref<EmailAccount[]>([])
const messages = ref<EmailMessage[]>([])
const selectedId = ref('')
const loading = ref(false)
const syncing = ref(false)
const categoryFilter = ref('all')
const error = ref('')
let servicePromise: Promise<EmailService> | null = null

const service = () => (servicePromise ??= createEmailService())
const visibleMessages = computed(() =>
  categoryFilter.value === 'all'
    ? messages.value
    : messages.value.filter(
        (message) =>
          accounts.value.find((account) => account.id === message.accountId)?.sourceCategory ===
          categoryFilter.value,
      ),
)
const categoryOptions = computed(() => [
  'all',
  ...new Set(accounts.value.map((account) => account.sourceCategory)),
])
const selected = computed(
  () => visibleMessages.value.find((message) => message.id === selectedId.value) ?? null,
)
const pendingCount = computed(
  () => visibleMessages.value.filter((message) => message.processingStatus === 'pending').length,
)
const unreadCount = computed(
  () => visibleMessages.value.filter((message) => !message.serverIsRead).length,
)
const selectedAccount = computed(
  () => accounts.value.find((account) => account.id === selected.value?.accountId) ?? null,
)
const latestSyncAt = computed(() =>
  accounts.value.reduce<number | null>(
    (latest, account) =>
      account.lastSyncedAt && (!latest || account.lastSyncedAt > latest)
        ? account.lastSyncedAt
        : latest,
    null,
  ),
)
const latestCursorAt = computed(() =>
  accounts.value.reduce<number | null>(
    (latest, account) =>
      account.syncCursorAt && (!latest || account.syncCursorAt > latest)
        ? account.syncCursorAt
        : latest,
    null,
  ),
)

async function load(): Promise<void> {
  if (!native) return
  loading.value = true
  error.value = ''
  const [accountResult, messageResult] = await Promise.all([
    (await service()).listAccounts(),
    (await service()).listMessages({
      status: props.mode === 'pending' ? 'pending' : undefined,
      limit: 200,
    }),
  ])
  loading.value = false
  if (!accountResult.ok) return void (error.value = accountResult.error.message)
  if (!messageResult.ok) return void (error.value = messageResult.error.message)
  accounts.value = accountResult.value
  messages.value = messageResult.value
  const requested = props.targetId
  if (requested && visibleMessages.value.some((message) => message.id === requested))
    selectedId.value = requested
  else if (!visibleMessages.value.some((message) => message.id === selectedId.value))
    selectedId.value = visibleMessages.value[0]?.id ?? ''
}

async function syncAll(): Promise<void> {
  syncing.value = true
  error.value = ''
  let syncedMessages = 0
  let syncError = ''
  try {
    for (const account of accounts.value) {
      const result = await (await service()).syncAccount(account)
      if (result.ok) syncedMessages += result.value
      else syncError = result.error.message
    }
    await load()
    if (syncError) error.value = syncError
    else notify.success(`邮箱同步完成，读取 ${syncedMessages} 封邮件`)
  } finally {
    syncing.value = false
  }
}

async function setStatus(message: EmailMessage, status: EmailProcessingStatus): Promise<void> {
  const result = await (await service()).setMessageStatus(message.id, status)
  if (!result.ok) return void (error.value = result.error.message)
  if (props.mode === 'pending' && status !== 'pending') {
    messages.value = messages.value.filter((candidate) => candidate.id !== message.id)
    selectedId.value = messages.value[0]?.id ?? ''
  } else {
    messages.value = messages.value.map((candidate) =>
      candidate.id === message.id ? result.value : candidate,
    )
  }
}

function processingLabel(status: EmailProcessingStatus): string {
  if (status === 'done') return '已处理'
  if (status === 'archived') return '已归档'
  return '待处理'
}

function formatListTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
  }
  return new Intl.DateTimeFormat('zh-CN', {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' }),
    month: '2-digit',
    day: '2-digit',
  }).format(date)
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

function accountName(accountId: string): string {
  return accounts.value.find((account) => account.id === accountId)?.displayName ?? '邮箱'
}

onMounted(() => void load())
watch(
  () => props.mode,
  () => void load(),
)
watch(
  () => props.targetId,
  (targetId) => {
    if (targetId && visibleMessages.value.some((message) => message.id === targetId))
      selectedId.value = targetId
  },
)
watch(categoryFilter, () => {
  selectedId.value = visibleMessages.value[0]?.id ?? ''
})
</script>

<template>
  <section class="email-inbox-panel" aria-label="邮件收件箱">
    <header class="email-inbox-panel__toolbar">
      <div class="email-inbox-panel__metrics" aria-label="邮件统计">
        <div>
          <strong>{{ visibleMessages.length }}</strong
          ><span>当前载入</span>
        </div>
        <div>
          <strong>{{ pendingCount }}</strong
          ><span>待处理</span>
        </div>
        <div>
          <strong>{{ unreadCount }}</strong
          ><span>服务器未读</span>
        </div>
      </div>
      <div class="email-inbox-panel__sync">
        <span v-if="latestSyncAt"
          >CHECK · {{ formatFullTime(latestSyncAt)
          }}<template v-if="latestCursorAt">
            / CONTENT · {{ formatFullTime(latestCursorAt) }}</template
          ></span
        >
        <span v-else>尚未完成同步</span>
        <button type="button" :disabled="!native || syncing || !accounts.length" @click="syncAll">
          <RefreshCw :class="{ 'is-spinning': syncing }" :size="15" />{{
            syncing ? '同步中' : '同步邮箱'
          }}
        </button>
      </div>
    </header>
    <p v-if="error" class="email-inbox-panel__error" role="alert">{{ error }}</p>
    <nav v-if="categoryOptions.length > 2" class="inbox-source-filters" aria-label="邮件来源分类">
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
    <div v-if="loading" class="inbox-empty-state"><span>正在读取本地邮件…</span></div>
    <div v-else-if="!accounts.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Mail :size="25" /></span>
      <h2>先连接一个邮箱账户</h2>
      <button type="button" @click="emit('openConnections')">连接邮箱</button>
    </div>
    <div v-else-if="!visibleMessages.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Inbox :size="25" /></span>
      <h2>{{ mode === 'pending' ? '没有待处理邮件' : '还没有同步邮件' }}</h2>
    </div>
    <div v-else class="email-inbox-layout">
      <div class="email-message-list" role="listbox" aria-label="邮件列表">
        <button
          v-for="(message, index) in visibleMessages"
          :key="message.id"
          type="button"
          role="option"
          :class="{ 'is-active': selectedId === message.id, 'is-unread': !message.serverIsRead }"
          :aria-selected="selectedId === message.id"
          @click="selectedId = message.id"
        >
          <span class="email-message-list__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="email-message-list__content">
            <span class="email-message-list__sender"
              ><strong>{{ message.fromName || message.fromAddress || '未知发件人' }}</strong
              ><time>{{ formatListTime(message.receivedAt) }}</time></span
            >
            <span class="email-message-list__subject">{{ message.subject }}</span>
            <span class="email-message-list__preview">{{ message.preview }}</span>
            <span class="email-message-list__footer">
              <small :data-status="message.processingStatus">{{
                processingLabel(message.processingStatus)
              }}</small>
              <span v-if="!message.serverIsRead" class="email-message-list__unread">未读</span>
              <span>{{ accountName(message.accountId) }}</span>
              <span v-if="message.attachmentCount"
                ><Paperclip :size="11" />{{ message.attachmentCount }}</span
              >
            </span>
          </span>
        </button>
      </div>
      <article v-if="selected" class="email-message-detail">
        <header>
          <div>
            <span
              >EMAIL / {{ selected.mailbox }} ·
              {{ selectedAccount?.displayName || 'MAILBOX' }}</span
            >
            <h2>{{ selected.subject }}</h2>
            <div class="email-message-detail__sender">
              <span>{{
                (selected.fromName || selected.fromAddress || '?').slice(0, 1).toUpperCase()
              }}</span>
              <p>
                <strong>{{ selected.fromName || selected.fromAddress || '未知发件人' }}</strong>
                <small v-if="selected.fromName">{{ selected.fromAddress }}</small>
              </p>
            </div>
          </div>
          <div class="email-message-detail__actions">
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
          <dt>账户</dt>
          <dd>{{ selectedAccount?.emailAddress || '—' }}</dd>
          <dt>收件人</dt>
          <dd>{{ selected.toAddresses.join(', ') || '—' }}</dd>
          <dt>时间</dt>
          <dd>{{ formatFullTime(selected.receivedAt) }}</dd>
          <dt>附件</dt>
          <dd>{{ selected.attachmentCount }} 个</dd>
          <dt>服务端</dt>
          <dd>{{ selected.serverIsRead ? '已读' : '未读（本地阅读不会改变）' }}</dd>
        </dl>
        <section class="email-message-detail__body">
          <pre>{{ selected.bodyText || selected.preview || '邮件正文为空。' }}</pre>
        </section>
      </article>
    </div>
  </section>
</template>
