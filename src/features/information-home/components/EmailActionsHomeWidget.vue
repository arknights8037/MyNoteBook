<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import type { EmailAccount, EmailMessage } from '@/models/inbox/email'

const props = defineProps<{ limit: number }>()
const emit = defineEmits<{
  open: []
  refreshing: [value: boolean]
  metrics: [items: Array<{ value: number; label: string }>]
}>()
const accounts = ref<EmailAccount[]>([])
const messages = ref<EmailMessage[]>([])
const error = ref('')
const loading = ref(true)
const visible = computed(() => messages.value.slice(0, props.limit))

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  emit('refreshing', true)
  try {
    const service = await createEmailService()
    const [accountResult, messageResult] = await Promise.all([
      service.listAccounts(),
      service.listMessages({ status: 'pending', limit: props.limit }),
    ])
    if (!accountResult.ok) throw new Error(accountResult.error.message)
    if (!messageResult.ok) throw new Error(messageResult.error.message)
    accounts.value = accountResult.value
    messages.value = messageResult.value
    emit('metrics', [
      { value: messages.value.length, label: '待处理' },
      { value: accounts.value.length, label: '账户' },
      { value: messages.value.filter((item) => !item.serverIsRead).length, label: '未读' },
    ])
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
    emit('refreshing', false)
  }
}

function accountName(id: string): string {
  return accounts.value.find((account) => account.id === id)?.displayName ?? '邮箱'
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
    <p v-else-if="!visible.length" class="dashboard-widget-state">当前没有待处理邮件。</p>
    <ul v-else class="dashboard-widget-list">
      <li v-for="item in visible" :key="item.id">
        <span class="dashboard-status-dot dashboard-status-dot--pending" />
        <span class="dashboard-widget-list__main"
          ><strong>{{ item.subject }}</strong
          ><small
            >{{ item.fromName || item.fromAddress }} · {{ accountName(item.accountId) }}</small
          ></span
        >
        <em>{{ new Date(item.receivedAt).toLocaleDateString() }}</em>
      </li>
    </ul>
    <button type="button" class="home-signal-widget__open" @click="emit('open')">
      打开邮件收件箱
    </button>
  </div>
</template>
