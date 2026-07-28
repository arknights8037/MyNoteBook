<script setup lang="ts">
import { AlertTriangle, ArrowRight, Mail, Rss, ShieldCheck } from '@lucide/vue'
import { onMounted, ref } from 'vue'

import { createEmailService } from '@/app/composition/emailServiceFactory'
import { createRssService } from '@/app/composition/rssServiceFactory'

const emit = defineEmits<{ openConnections: [] }>()
const issues = ref<Array<{ id: string; kind: 'email' | 'rss'; name: string; detail: string }>>([])
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  if (!Reflect.has(globalThis, '__TAURI_INTERNALS__')) return
  loading.value = true
  error.value = ''
  const [email, rss] = await Promise.all([createEmailService(), createRssService()])
  const [accounts, sources] = await Promise.all([email.listAccounts(), rss.listSources()])
  loading.value = false
  if (!accounts.ok) return void (error.value = accounts.error.message)
  if (!sources.ok) return void (error.value = sources.error.message)
  issues.value = [
    ...accounts.value
      .filter((account) => account.lastError)
      .map((account) => ({
        id: `email:${account.id}`,
        kind: 'email' as const,
        name: account.displayName,
        detail: account.lastError!,
      })),
    ...sources.value
      .filter((source) => source.lastError)
      .map((source) => ({
        id: `rss:${source.id}`,
        kind: 'rss' as const,
        name: source.displayName,
        detail: source.lastError!,
      })),
  ]
}

onMounted(() => void load())
</script>

<template>
  <section v-if="loading" class="inbox-empty-state"><span>正在检查连接器状态…</span></section>
  <section v-else-if="error" class="inbox-empty-state">
    <AlertTriangle :size="25" />
    <h2>无法读取连接器状态</h2>
    <p>{{ error }}</p>
  </section>
  <section v-else-if="!issues.length" class="inbox-empty-state">
    <span class="inbox-empty-state__icon"><ShieldCheck :size="25" /></span>
    <h2>当前没有采集异常</h2>
    <p>邮箱与 RSS 最近一次同步没有记录错误。</p>
  </section>
  <section v-else class="connector-failure-list" aria-label="采集异常列表">
    <header>
      <strong>{{ issues.length }} 个连接器需要处理</strong
      ><button type="button" @click="emit('openConnections')">
        打开连接器<ArrowRight :size="14" />
      </button>
    </header>
    <article v-for="issue in issues" :key="issue.id">
      <span><component :is="issue.kind === 'email' ? Mail : Rss" :size="17" /></span>
      <div>
        <small>{{ issue.kind === 'email' ? 'EMAIL' : 'RSS' }}</small
        ><strong>{{ issue.name }}</strong>
        <p>{{ issue.detail }}</p>
      </div>
    </article>
  </section>
</template>
