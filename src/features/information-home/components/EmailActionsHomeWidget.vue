<script setup lang="ts">
import { ArrowUpRight, Check, EyeOff } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import type { InformationHomeSummary } from '@/models/home/informationHome'
import type { EmailAccount, EmailMessage, EmailProcessingStatus } from '@/models/inbox/email'
import { buildSignalResultDigest } from '@/services/home/SignalResultDigestService'

const props = defineProps<{ limit: number; summaries: InformationHomeSummary[] }>()
const emit = defineEmits<{
  open: [id?: string]
  refreshing: [value: boolean]
  metrics: [items: Array<{ value: number; label: string }>]
}>()
const accounts = ref<EmailAccount[]>([])
const messages = ref<EmailMessage[]>([])
const error = ref('')
const loading = ref(true)
const processingId = ref('')
const briefByMessageId = computed(
  () =>
    new Map(
      buildSignalResultDigest(props.summaries).emailBriefs.map((brief) => [brief.messageId, brief]),
    ),
)
const visible = computed(() =>
  messages.value.filter((message) => briefByMessageId.value.has(message.id)).slice(0, props.limit),
)

function publishMetrics(): void {
  emit('metrics', [
    { value: messages.value.length, label: '待处理' },
    { value: accounts.value.length, label: '账户' },
    { value: messages.value.filter((item) => !item.serverIsRead).length, label: '未读' },
  ])
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  emit('refreshing', true)
  try {
    const service = await createEmailService()
    const [accountResult, messageResult] = await Promise.all([
      service.listAccounts(),
      service.listMessages({ status: 'pending', limit: Math.max(props.limit, 30) }),
    ])
    if (!accountResult.ok) throw new Error(accountResult.error.message)
    if (!messageResult.ok) throw new Error(messageResult.error.message)
    accounts.value = accountResult.value
    messages.value = messageResult.value
    publishMetrics()
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
    emit('refreshing', false)
  }
}

async function setStatus(message: EmailMessage, status: EmailProcessingStatus): Promise<void> {
  processingId.value = message.id
  error.value = ''
  try {
    const result = await (await createEmailService()).setMessageStatus(message.id, status)
    if (!result.ok) return void (error.value = result.error.message)
    messages.value = messages.value.filter((candidate) => candidate.id !== message.id)
    publishMetrics()
  } finally {
    processingId.value = ''
  }
}

defineExpose({ refresh })
onMounted(() => void refresh())
</script>

<template>
  <div class="dashboard-widget-content home-signal-widget">
    <p v-if="loading" class="dashboard-widget-state">正在读取邮件事项…</p>
    <div v-else-if="error" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>读取失败</strong><span>{{ error }}</span>
    </div>
    <p v-else-if="!accounts.length" class="dashboard-widget-state">尚未连接邮箱。</p>
    <p v-else-if="!messages.length" class="dashboard-widget-state">当前没有待处理邮件。</p>
    <p v-else-if="!visible.length" class="dashboard-widget-state">
      正在等待自动处理生成中文邮件简报…
    </p>
    <ul v-else class="dashboard-widget-list">
      <li v-for="item in visible" :key="item.id">
        <span class="dashboard-status-dot dashboard-status-dot--pending" />
        <span class="dashboard-widget-list__main"
          ><strong>{{ briefByMessageId.get(item.id)?.title }}</strong
          ><small>{{ briefByMessageId.get(item.id)?.summary }}</small></span
        >
        <span class="home-signal-widget__item-tools">
          <em>{{ new Date(item.receivedAt).toLocaleDateString() }}</em>
          <span>
            <button
              type="button"
              title="前往处理"
              aria-label="前往处理"
              @click="emit('open', item.id)"
            >
              <ArrowUpRight :size="13" />
            </button>
            <button
              type="button"
              title="标记为已处理"
              aria-label="标记为已处理"
              :disabled="processingId === item.id"
              @click="setStatus(item, 'done')"
            >
              <Check :size="13" />
            </button>
            <button
              type="button"
              title="忽略"
              aria-label="忽略"
              :disabled="processingId === item.id"
              @click="setStatus(item, 'archived')"
            >
              <EyeOff :size="13" />
            </button>
          </span>
        </span>
      </li>
    </ul>
    <button type="button" class="home-signal-widget__open" @click="emit('open', undefined)">
      打开邮件收件箱
    </button>
  </div>
</template>
