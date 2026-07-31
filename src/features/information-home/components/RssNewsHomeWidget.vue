<script setup lang="ts">
import { ArrowUpRight, Check, EyeOff, Flame } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import { createRssService } from '@/app/composition/rssServiceFactory'
import type { RssEntry, RssProcessingStatus, RssSource } from '@/models/inbox/rss'
import type { InformationHomeSummary } from '@/models/home/informationHome'
import { findLatestRssInsight } from '@/services/inbox/RssInsightService'

const props = defineProps<{
  limit: number
  summary: InformationHomeSummary | null
}>()
const emit = defineEmits<{
  open: [id?: string]
  refreshing: [value: boolean]
  metrics: [items: Array<{ value: number; label: string }>]
}>()
const sources = ref<RssSource[]>([])
const entries = ref<RssEntry[]>([])
const error = ref('')
const loading = ref(true)
const processingId = ref('')
const insight = computed(() => findLatestRssInsight(props.summary ? [props.summary] : []))
const hotItemById = computed(
  () => new Map(insight.value?.hotItems.map((item) => [item.entryId, item]) ?? []),
)
const orderedEntries = computed(() => {
  const pendingById = new Map(entries.value.map((entry) => [entry.id, entry]))
  return (insight.value?.hotItems ?? [])
    .map((item) => pendingById.get(item.entryId))
    .filter((entry): entry is RssEntry => Boolean(entry))
    .slice(0, props.limit)
})

function publishMetrics(): void {
  emit('metrics', [
    { value: entries.value.length, label: '待处理' },
    { value: sources.value.length, label: '来源' },
  ])
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  emit('refreshing', true)
  try {
    const service = await createRssService()
    const [sourceResult, entryResult] = await Promise.all([
      service.listSources(),
      service.listEntries({ status: 'pending', limit: Math.max(props.limit, 30) }),
    ])
    if (!sourceResult.ok) throw new Error(sourceResult.error.message)
    if (!entryResult.ok) throw new Error(entryResult.error.message)
    sources.value = sourceResult.value
    entries.value = entryResult.value
    publishMetrics()
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
    emit('refreshing', false)
  }
}

async function setStatus(entry: RssEntry, status: RssProcessingStatus): Promise<void> {
  if (processingId.value) return
  processingId.value = entry.id
  error.value = ''
  try {
    const result = await (await createRssService()).setEntryStatus(entry.id, status)
    if (!result.ok) return void (error.value = result.error.message)
    entries.value = entries.value.filter((candidate) => candidate.id !== entry.id)
    publishMetrics()
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    processingId.value = ''
  }
}

defineExpose({ refresh })
onMounted(() => void refresh())
</script>

<template>
  <div class="dashboard-widget-content home-signal-widget">
    <div v-if="insight?.hotItems.length" class="home-rss-insight-status">
      <Flame :size="13" /><span>已自动研判 · {{ insight.hotItems.length }} 条热点</span>
    </div>
    <p v-if="loading" class="dashboard-widget-state">正在读取 RSS 新闻…</p>
    <div v-else-if="error" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>读取失败</strong><span>{{ error }}</span>
    </div>
    <p v-else-if="!sources.length" class="dashboard-widget-state">尚未添加 RSS 来源。</p>
    <p v-else-if="!entries.length" class="dashboard-widget-state">当前没有 RSS 新闻。</p>
    <p v-else-if="!orderedEntries.length" class="dashboard-widget-state">
      正在等待自动研判生成中文热点条目…
    </p>
    <ul v-else class="dashboard-widget-list">
      <li
        v-for="item in orderedEntries"
        :key="item.id"
        class="is-rss-hot"
        :class="{ 'is-processing': processingId === item.id }"
        :aria-busy="processingId === item.id"
      >
        <span
          class="dashboard-status-dot"
          :class="`dashboard-status-dot--${item.processingStatus}`"
        />
        <span class="dashboard-widget-list__main"
          ><strong
            ><span class="home-rss-hot-label">热点</span
            >{{ hotItemById.get(item.id)?.title }}</strong
          ><small>{{ hotItemById.get(item.id)?.reason }}</small></span
        >
        <span class="home-signal-widget__item-tools">
          <em>{{ new Date(item.publishedAt).toLocaleDateString() }}</em>
          <span>
            <button
              type="button"
              title="前往处理"
              aria-label="前往处理"
              :disabled="processingId === item.id"
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
    <p v-if="processingId" class="home-system-feedback is-saving" role="status">
      正在向 RSS 系统提交处理结果…
    </p>
    <button type="button" class="home-signal-widget__open" @click="emit('open', undefined)">
      打开 RSS 收件箱
    </button>
  </div>
</template>
