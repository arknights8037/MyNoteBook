<script setup lang="ts">
import {
  Ban,
  Check,
  EyeOff,
  Inbox,
  Mail,
  Paperclip,
  RefreshCw,
  RotateCcw,
  ShieldOff,
  Trash2,
} from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import type {
  EmailAccount,
  EmailBlockedSender,
  EmailMessage,
  EmailProcessingStatus,
} from '@/models/inbox/email'
import type { EmailService } from '@/services/inbox/EmailService'
import { publishSignalRefresh } from '@/services/agent/SignalAgentService'
import { useMessage } from '@/ui/services'

const props = defineProps<{ mode: 'pending' | 'all' | 'email'; targetId?: string }>()
const emit = defineEmits<{ openConnections: [] }>()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const accounts = ref<EmailAccount[]>([])
const messages = ref<EmailMessage[]>([])
const blockedSenders = ref<EmailBlockedSender[]>([])
const selectedId = ref('')
const loading = ref(false)
const syncing = ref(false)
const categoryFilter = ref('all')
const error = ref('')
const showBlockedSenders = ref(false)
const activeOperation = ref<{
  kind: 'status' | 'delete' | 'block' | 'unblock'
  key: string
} | null>(null)
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
const operating = computed(() => activeOperation.value !== null)

async function load(): Promise<void> {
  if (!native) return
  loading.value = true
  error.value = ''
  const [accountResult, messageResult, blockedResult] = await Promise.all([
    (await service()).listAccounts(),
    (await service()).listMessages({
      status: props.mode === 'pending' ? 'pending' : undefined,
      limit: 200,
    }),
    (await service()).listBlockedSenders(),
  ])
  loading.value = false
  if (!accountResult.ok) return void (error.value = accountResult.error.message)
  if (!messageResult.ok) return void (error.value = messageResult.error.message)
  if (!blockedResult.ok) return void (error.value = blockedResult.error.message)
  accounts.value = accountResult.value
  messages.value = messageResult.value
  blockedSenders.value = blockedResult.value
  const requested = props.targetId
  if (requested && visibleMessages.value.some((message) => message.id === requested))
    selectedId.value = requested
  else if (!visibleMessages.value.some((message) => message.id === selectedId.value))
    selectedId.value = visibleMessages.value[0]?.id ?? ''
}

async function syncAll(): Promise<void> {
  const refreshStartedAt = Date.now()
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
    await publishSignalRefresh({
      since: refreshStartedAt,
      triggerSource: 'sync',
      importedCount: syncedMessages,
    })
    if (syncError) error.value = `${syncError}；已读取的邮件仍交给 Agent 处理。`
    else notify.success(`已读取 ${syncedMessages} 封邮件，Agent 正在自主处理`)
  } catch (syncFailure) {
    error.value = syncFailure instanceof Error ? syncFailure.message : String(syncFailure)
  } finally {
    syncing.value = false
  }
}

async function setStatus(message: EmailMessage, status: EmailProcessingStatus): Promise<void> {
  if (operating.value) return
  activeOperation.value = { kind: 'status', key: message.id }
  error.value = ''
  try {
    const result = await (await service()).setMessageStatus(message.id, status)
    if (!result.ok) return void (error.value = result.error.message)
    if (props.mode === 'pending' && status !== 'pending') {
      removeVisibleMessages((candidate) => candidate.id === message.id)
    } else {
      messages.value = messages.value.map((candidate) =>
        candidate.id === message.id ? result.value : candidate,
      )
    }
    notify.success(status === 'archived' ? '邮件已忽略' : '邮件状态已更新')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    activeOperation.value = null
  }
}

async function deleteMessage(message: EmailMessage): Promise<void> {
  if (
    operating.value ||
    !globalThis.confirm(
      `删除邮件“${message.subject || '无主题'}”的本地副本？服务器邮件不会被删除。`,
    )
  )
    return
  activeOperation.value = { kind: 'delete', key: message.id }
  error.value = ''
  try {
    const result = await (await service()).deleteMessage(message.id)
    if (!result.ok) return void (error.value = result.error.message)
    removeVisibleMessages((candidate) => candidate.id === message.id)
    notify.success('本地邮件已删除')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    activeOperation.value = null
  }
}

async function blockSender(message: EmailMessage): Promise<void> {
  const senderAddress = message.fromAddress.trim().toLocaleLowerCase()
  if (!senderAddress) return void (error.value = '该邮件没有可用于屏蔽的发件地址。')
  if (
    operating.value ||
    !globalThis.confirm(
      `屏蔽来源 ${senderAddress}？该来源的本地邮件会被清理，后续同步也不会再入库。`,
    )
  )
    return
  activeOperation.value = { kind: 'block', key: `${message.accountId}:${senderAddress}` }
  error.value = ''
  try {
    const result = await (await service()).blockSender(message.accountId, senderAddress)
    if (!result.ok) return void (error.value = result.error.message)
    blockedSenders.value = [
      result.value.sender,
      ...blockedSenders.value.filter(
        (sender) =>
          !(
            sender.accountId === result.value.sender.accountId &&
            sender.senderAddress === result.value.sender.senderAddress
          ),
      ),
    ]
    removeVisibleMessages(
      (candidate) =>
        candidate.accountId === message.accountId &&
        candidate.fromAddress.trim().toLocaleLowerCase() === senderAddress,
    )
    notify.success(
      result.value.removedCount
        ? `已屏蔽来源并清理 ${result.value.removedCount} 封本地邮件`
        : '邮件来源已加入屏蔽列表',
    )
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    activeOperation.value = null
  }
}

async function unblockSender(sender: EmailBlockedSender): Promise<void> {
  if (operating.value) return
  activeOperation.value = {
    kind: 'unblock',
    key: `${sender.accountId}:${sender.senderAddress}`,
  }
  error.value = ''
  try {
    const result = await (await service()).unblockSender(sender.accountId, sender.senderAddress)
    if (!result.ok) return void (error.value = result.error.message)
    blockedSenders.value = blockedSenders.value.filter(
      (candidate) =>
        !(
          candidate.accountId === sender.accountId &&
          candidate.senderAddress === sender.senderAddress
        ),
    )
    notify.success('已解除来源屏蔽，后续新邮件可以再次同步')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    activeOperation.value = null
  }
}

function removeVisibleMessages(predicate: (message: EmailMessage) => boolean): void {
  messages.value = messages.value.filter((message) => !predicate(message))
  if (!visibleMessages.value.some((message) => message.id === selectedId.value)) {
    selectedId.value = visibleMessages.value[0]?.id ?? ''
  }
}

function processingLabel(status: EmailProcessingStatus): string {
  if (status === 'done') return '已处理'
  if (status === 'archived') return '已忽略'
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
        <button
          type="button"
          :class="{ 'is-active': showBlockedSenders }"
          :aria-expanded="showBlockedSenders"
          @click="showBlockedSenders = !showBlockedSenders"
        >
          <ShieldOff :size="15" />屏蔽列表
          <strong v-if="blockedSenders.length">{{ blockedSenders.length }}</strong>
        </button>
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
    <section v-if="showBlockedSenders" class="email-blocked-senders" aria-label="邮件来源屏蔽列表">
      <header>
        <div>
          <strong>已屏蔽来源</strong>
          <small>只影响本地入库，不会修改服务器邮箱规则。</small>
        </div>
        <span>{{ blockedSenders.length }} 个来源</span>
      </header>
      <p v-if="!blockedSenders.length">暂无被屏蔽的邮件来源。</p>
      <div v-else>
        <article
          v-for="sender in blockedSenders"
          :key="`${sender.accountId}:${sender.senderAddress}`"
        >
          <Ban :size="15" />
          <span>
            <strong>{{ sender.senderAddress }}</strong>
            <small
              >{{ accountName(sender.accountId) }} · {{ formatFullTime(sender.createdAt) }}</small
            >
          </span>
          <button type="button" :disabled="operating" @click="unblockSender(sender)">
            <RotateCcw :size="13" />解除屏蔽
          </button>
        </article>
      </div>
    </section>
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
      <article v-if="selected" class="email-message-detail" :aria-busy="operating">
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
              :disabled="operating"
              @click="setStatus(selected, 'pending')"
            >
              <RotateCcw :size="14" />恢复待处理
            </button>
            <button
              v-if="selected.processingStatus !== 'done'"
              type="button"
              :disabled="operating"
              @click="setStatus(selected, 'done')"
            >
              <Check :size="14" />标记已处理
            </button>
            <button
              v-if="selected.processingStatus !== 'archived'"
              type="button"
              :disabled="operating"
              @click="setStatus(selected, 'archived')"
            >
              <EyeOff :size="14" />忽略
            </button>
            <button
              type="button"
              :disabled="operating || !selected.fromAddress.trim()"
              title="屏蔽后，该来源的后续邮件将不再保存到本地"
              @click="blockSender(selected)"
            >
              <Ban :size="14" />屏蔽来源
            </button>
            <button
              type="button"
              class="is-danger"
              :disabled="operating"
              title="仅删除本地副本"
              @click="deleteMessage(selected)"
            >
              <Trash2 :size="14" />删除本地
            </button>
          </div>
        </header>
        <p v-if="activeOperation" class="email-message-detail__operation" role="status">
          {{
            activeOperation.kind === 'delete'
              ? '正在删除本地邮件…'
              : activeOperation.kind === 'block'
                ? '正在写入来源屏蔽规则…'
                : activeOperation.kind === 'unblock'
                  ? '正在解除来源屏蔽…'
                  : '正在更新邮件状态…'
          }}
        </p>
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
