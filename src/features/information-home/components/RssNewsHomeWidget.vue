<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { createRssService } from '@/app/composition/rssServiceFactory'
import type { RssEntry, RssSource } from '@/models/inbox/rss'

const props = defineProps<{ limit: number }>()
const emit = defineEmits<{
  open: []
  refreshing: [value: boolean]
  metrics: [items: Array<{ value: number; label: string }>]
}>()
const sources = ref<RssSource[]>([])
const entries = ref<RssEntry[]>([])
const error = ref('')
const loading = ref(true)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  emit('refreshing', true)
  try {
    const service = await createRssService()
    const [sourceResult, entryResult] = await Promise.all([
      service.listSources(),
      service.listEntries({ limit: props.limit }),
    ])
    if (!sourceResult.ok) throw new Error(sourceResult.error.message)
    if (!entryResult.ok) throw new Error(entryResult.error.message)
    sources.value = sourceResult.value
    entries.value = entryResult.value
    emit('metrics', [
      { value: entries.value.length, label: '文章' },
      { value: sources.value.length, label: '来源' },
      {
        value: entries.value.filter((item) => item.processingStatus === 'pending').length,
        label: '待处理',
      },
    ])
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
    emit('refreshing', false)
  }
}

function sourceName(id: string): string {
  return sources.value.find((source) => source.id === id)?.displayName ?? 'RSS'
}

defineExpose({ refresh })
onMounted(() => void refresh())
</script>

<template>
  <div class="dashboard-widget-content home-signal-widget">
    <p v-if="loading" class="dashboard-widget-state">正在读取 RSS 新闻…</p>
    <div v-else-if="error" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>读取失败</strong><span>{{ error }}</span>
    </div>
    <p v-else-if="!sources.length" class="dashboard-widget-state">尚未添加 RSS 来源。</p>
    <p v-else-if="!entries.length" class="dashboard-widget-state">当前没有 RSS 新闻。</p>
    <ul v-else class="dashboard-widget-list">
      <li v-for="item in entries" :key="item.id">
        <span
          class="dashboard-status-dot"
          :class="`dashboard-status-dot--${item.processingStatus}`"
        />
        <span class="dashboard-widget-list__main"
          ><strong>{{ item.title }}</strong
          ><small
            >{{ item.author || sourceName(item.sourceId) }} · {{ sourceName(item.sourceId) }}</small
          ></span
        >
        <em>{{ new Date(item.publishedAt).toLocaleDateString() }}</em>
      </li>
    </ul>
    <button type="button" class="home-signal-widget__open" @click="emit('open')">
      打开 RSS 收件箱
    </button>
  </div>
</template>
