<script setup lang="ts">
import { Archive, Check, Inbox, Mail, Paperclip, RefreshCw, RotateCcw } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import type { EmailAccount, EmailMessage, EmailProcessingStatus } from '@/models/inbox/email'
import type { EmailService } from '@/services/inbox/EmailService'

const props = defineProps<{ mode: 'pending' | 'all' | 'email' }>()
const emit = defineEmits<{ openConnections: [] }>()
const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const accounts = ref<EmailAccount[]>([])
const messages = ref<EmailMessage[]>([])
const selectedId = ref('')
const loading = ref(false)
const syncing = ref(false)
const error = ref('')
let servicePromise: Promise<EmailService> | null = null

const service = () => (servicePromise ??= createEmailService())
const selected = computed(
  () => messages.value.find((message) => message.id === selectedId.value) ?? null,
)
const pendingCount = computed(
  () => messages.value.filter((message) => message.processingStatus === 'pending').length,
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
  if (!messages.value.some((message) => message.id === selectedId.value)) {
    selectedId.value = messages.value[0]?.id ?? ''
  }
}

async function syncAll(): Promise<void> {
  syncing.value = true
  error.value = ''
  try {
    for (const account of accounts.value) {
      const result = await (await service()).syncAccount(account)
      if (!result.ok) error.value = result.error.message
    }
    await load()
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

onMounted(() => void load())
watch(
  () => props.mode,
  () => void load(),
)
</script>

<template>
  <section class="email-inbox-panel" aria-label="邮件收件箱">
    <header class="email-inbox-panel__toolbar">
      <div>
        <strong>{{ messages.length }} 封邮件</strong
        ><span>{{ pendingCount }} 封待处理 · {{ accounts.length }} 个账户</span>
      </div>
      <button type="button" :disabled="!native || syncing || !accounts.length" @click="syncAll">
        <RefreshCw :class="{ 'is-spinning': syncing }" :size="15" />同步邮箱
      </button>
    </header>
    <p v-if="error" class="email-inbox-panel__error">{{ error }}</p>
    <div v-if="loading" class="inbox-empty-state"><span>正在读取本地邮件…</span></div>
    <div v-else-if="!accounts.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Mail :size="25" /></span>
      <h2>先连接一个邮箱账户</h2>
      <p>邮箱连接在“连接与扩展”中配置，邮件内容会回到这里处理。</p>
      <button type="button" @click="emit('openConnections')">连接邮箱</button>
    </div>
    <div v-else-if="!messages.length" class="inbox-empty-state">
      <span class="inbox-empty-state__icon"><Inbox :size="25" /></span>
      <h2>{{ mode === 'pending' ? '没有待处理邮件' : '还没有同步邮件' }}</h2>
      <p>点击同步邮箱读取最近邮件；服务器内容和已读状态不会被修改。</p>
    </div>
    <div v-else class="email-inbox-layout">
      <div class="email-message-list" role="listbox" aria-label="邮件列表">
        <button
          v-for="message in messages"
          :key="message.id"
          type="button"
          :class="{ 'is-active': selectedId === message.id, 'is-unread': !message.serverIsRead }"
          @click="selectedId = message.id"
        >
          <span class="email-message-list__sender"
            ><strong>{{ message.fromName || message.fromAddress || '未知发件人' }}</strong
            ><time>{{ new Date(message.receivedAt).toLocaleString() }}</time></span
          >
          <span class="email-message-list__subject">{{ message.subject }}</span>
          <span class="email-message-list__preview">{{ message.preview }}</span>
          <small
            ><Paperclip v-if="message.attachmentCount" :size="11" />{{
              message.processingStatus === 'pending'
                ? '待处理'
                : message.processingStatus === 'done'
                  ? '已处理'
                  : '已归档'
            }}</small
          >
        </button>
      </div>
      <article v-if="selected" class="email-message-detail">
        <header>
          <div>
            <span>EMAIL · {{ selected.mailbox }}</span>
            <h2>{{ selected.subject }}</h2>
            <p>
              {{ selected.fromName || selected.fromAddress }}
              <small v-if="selected.fromName">&lt;{{ selected.fromAddress }}&gt;</small>
            </p>
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
          <dt>收件人</dt>
          <dd>{{ selected.toAddresses.join(', ') || '—' }}</dd>
          <dt>时间</dt>
          <dd>{{ new Date(selected.receivedAt).toLocaleString() }}</dd>
          <dt>附件</dt>
          <dd>{{ selected.attachmentCount }} 个</dd>
        </dl>
        <pre>{{ selected.bodyText || selected.preview || '邮件正文为空。' }}</pre>
      </article>
    </div>
  </section>
</template>
