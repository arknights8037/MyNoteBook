<script setup lang="ts">
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  Archive,
  Check,
  CircleDot,
  Inbox,
  MessageCircle,
  Paperclip,
  RotateCcw,
  ShieldAlert,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { createDingTalkService } from '@/app/composition/dingTalkServiceFactory'
import type { ImConnector, ImMessage, ImProcessingStatus } from '@/models/inbox/im'
import type { DingTalkService } from '@/services/inbox/DingTalkService'

const props = defineProps<{ mode: 'pending' | 'all' | 'messages' }>()
const emit = defineEmits<{ openConnections: [] }>()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const connectors = ref<ImConnector[]>([])
const messages = ref<ImMessage[]>([])
const selectedId = ref('')
const categoryFilter = ref('all')
const loading = ref(false)
const error = ref('')
let servicePromise: Promise<DingTalkService> | null = null
let unlisten: UnlistenFn | null = null
let refreshTimer: ReturnType<typeof globalThis.setInterval> | null = null

const service = () => (servicePromise ??= createDingTalkService())
const categoryOptions = computed(() => [
  'all',
  ...new Set(connectors.value.map((connector) => connector.sourceCategory)),
])
const visibleMessages = computed(() =>
  categoryFilter.value === 'all'
    ? messages.value
    : messages.value.filter(
        (message) =>
          connectors.value.find((connector) => connector.id === message.connectorId)
            ?.sourceCategory === categoryFilter.value,
      ),
)
const selected = computed(
  () => visibleMessages.value.find((message) => message.id === selectedId.value) ?? null,
)
const selectedConnector = computed(
  () => connectors.value.find((connector) => connector.id === selected.value?.connectorId) ?? null,
)
const onlineCount = computed(
  () => connectors.value.filter((connector) => connector.runtimeStatus === 'online').length,
)
const pendingCount = computed(
  () => visibleMessages.value.filter((message) => message.processingStatus === 'pending').length,
)
const latestEventAt = computed(() =>
  connectors.value.reduce<number | null>(
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
  const [connectorResult, messageResult] = await Promise.all([
    (await service()).listConnectors(),
    (await service()).listMessages({
      status: props.mode === 'pending' ? 'pending' : undefined,
      limit: 250,
    }),
  ])
  if (showLoading) loading.value = false
  if (!connectorResult.ok) return void (error.value = connectorResult.error.message)
  if (!messageResult.ok) return void (error.value = messageResult.error.message)
  connectors.value = connectorResult.value
  messages.value = messageResult.value
  if (!visibleMessages.value.some((message) => message.id === selectedId.value))
    selectedId.value = visibleMessages.value[0]?.id ?? ''
}

async function setStatus(message: ImMessage, status: ImProcessingStatus): Promise<void> {
  const result = await (await service()).setMessageStatus(message.id, status)
  if (!result.ok) return void (error.value = result.error.message)
  if (props.mode === 'pending' && status !== 'pending') {
    messages.value = messages.value.filter((candidate) => candidate.id !== message.id)
    selectedId.value = visibleMessages.value[0]?.id ?? ''
  } else {
    messages.value = messages.value.map((candidate) =>
      candidate.id === message.id ? result.value : candidate,
    )
  }
}

function connectorName(id: string): string {
  return connectors.value.find((connector) => connector.id === id)?.displayName ?? '钉钉'
}

function processingLabel(status: ImProcessingStatus): string {
  if (status === 'done') return '已处理'
  if (status === 'archived') return '已归档'
  return '待处理'
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

onMounted(async () => {
  await load()
  if (!native) return
  unlisten = await listen('dingtalk-message-received', () => void load(false))
  refreshTimer = globalThis.setInterval(() => void load(false), 10_000)
})
onBeforeUnmount(() => {
  unlisten?.()
  if (refreshTimer) globalThis.clearInterval(refreshTimer)
})
watch(
  () => props.mode,
  () => void load(),
)
watch(categoryFilter, () => {
  selectedId.value = visibleMessages.value[0]?.id ?? ''
})
</script>

<template>
  <section class="email-inbox-panel im-inbox-panel" aria-label="钉钉消息收件箱">
    <header class="email-inbox-panel__toolbar">
      <div class="email-inbox-panel__metrics" aria-label="钉钉消息统计">
        <div>
          <strong>{{ visibleMessages.length }}</strong
          ><span>当前载入</span>
        </div>
        <div>
          <strong>{{ pendingCount }}</strong
          ><span>待处理</span>
        </div>
        <div>
          <strong>{{ onlineCount }}</strong
          ><span>在线连接</span>
        </div>
      </div>
      <div class="email-inbox-panel__sync">
        <span v-if="latestEventAt">LATEST · {{ formatFullTime(latestEventAt) }}</span>
        <span v-else>等待 Stream 消息</span>
        <i><CircleDot :size="13" />实时接收</i>
      </div>
    </header>
    <p v-if="error" class="email-inbox-panel__error" role="alert">{{ error }}</p>
    <aside class="inbox-boundary-note">
      <ShieldAlert :size="16" />
      <p>
        <strong>实时通道，不是历史同步。</strong>单聊机器人无需 @；群聊只有 @机器人消息会进入。
        应用关闭期间消息可能无法补拉。
      </p>
    </aside>
    <nav v-if="categoryOptions.length > 2" class="inbox-source-filters" aria-label="消息来源分类">
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
    <div v-if="loading" class="inbox-empty-state"><span>正在读取本地消息…</span></div>
    <div v-else-if="!connectors.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><MessageCircle :size="25" /></span>
      <h2>先连接一个钉钉机器人</h2>
      <p>连接在“连接与扩展”中配置；应用在线时消息会自动进入这里。</p>
      <button type="button" @click="emit('openConnections')">连接钉钉</button>
    </div>
    <div v-else-if="!visibleMessages.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Inbox :size="25" /></span>
      <h2>{{ mode === 'pending' ? '没有待处理消息' : '正在等待钉钉消息' }}</h2>
      <p>给机器人发送单聊消息，或在群聊中 @机器人，保持桌面应用在线即可接收。</p>
    </div>
    <div v-else class="email-inbox-layout">
      <div class="email-message-list" role="listbox" aria-label="钉钉消息列表">
        <button
          v-for="(item, index) in visibleMessages"
          :key="item.id"
          type="button"
          role="option"
          :class="{
            'is-active': selectedId === item.id,
            'is-unread': item.processingStatus === 'pending',
          }"
          :aria-selected="selectedId === item.id"
          @click="selectedId = item.id"
        >
          <span class="email-message-list__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="email-message-list__content">
            <span class="email-message-list__sender">
              <strong>{{ item.senderName || '钉钉用户' }}</strong>
              <time>{{ formatListTime(item.sentAt) }}</time>
            </span>
            <span class="email-message-list__subject">{{ item.conversationTitle }}</span>
            <span class="email-message-list__preview">{{ item.bodyText }}</span>
            <span class="email-message-list__footer">
              <small :data-status="item.processingStatus">{{
                processingLabel(item.processingStatus)
              }}</small>
              <span>{{ item.conversationType === 'group' ? '群聊 @' : '单聊' }}</span>
              <span>{{ connectorName(item.connectorId) }}</span>
              <span v-if="item.attachmentCount"
                ><Paperclip :size="11" />{{ item.attachmentCount }}</span
              >
            </span>
          </span>
        </button>
      </div>
      <article v-if="selected" class="email-message-detail">
        <header>
          <div>
            <span
              >DINGTALK /
              {{ selected.conversationType === 'group' ? 'GROUP @BOT' : 'DIRECT' }}</span
            >
            <h2>{{ selected.conversationTitle }}</h2>
            <div class="email-message-detail__sender">
              <span>{{ (selected.senderName || '?').slice(0, 1).toUpperCase() }}</span>
              <p>
                <strong>{{ selected.senderName || '钉钉用户' }}</strong
                ><small>{{ selected.senderId || '无员工 ID' }}</small>
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
          <dt>连接</dt>
          <dd>{{ selectedConnector?.displayName || '钉钉' }}</dd>
          <dt>分类</dt>
          <dd>{{ selectedConnector?.sourceCategory || '未分类' }}</dd>
          <dt>会话</dt>
          <dd>{{ selected.conversationType === 'group' ? '群聊中 @机器人' : '机器人单聊' }}</dd>
          <dt>时间</dt>
          <dd>{{ formatFullTime(selected.sentAt) }}</dd>
          <dt>类型</dt>
          <dd>{{ selected.messageType }}</dd>
        </dl>
        <section class="email-message-detail__body">
          <header><span>MESSAGE BODY</span><small>只读纯文本</small></header>
          <pre>{{ selected.bodyText || '消息正文为空。' }}</pre>
        </section>
      </article>
    </div>
  </section>
</template>
