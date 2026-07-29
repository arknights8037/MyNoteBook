<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import type { AutomationRun, AutomationRunStatus } from '@/models/automation/automation'
import type { AutomationService } from '@/services/automation/AutomationService'

const props = defineProps<{
  getService: () => Promise<AutomationService>
  limit: number
}>()

const emit = defineEmits<{ refreshing: [value: boolean] }>()
const runs = ref<AutomationRun[]>([])
const loading = ref(true)
const error = ref('')

const counts = computed(() => ({
  running: runs.value.filter((run) => run.status === 'running' || run.status === 'queued').length,
  completed: runs.value.filter((run) => run.status === 'completed').length,
  failed: runs.value.filter((run) => run.status === 'failed').length,
}))

const statusLabels: Record<AutomationRunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  emit('refreshing', true)
  try {
    const result = await (await props.getService()).listRuns(props.limit)
    if (!result.ok) throw new Error(result.error.message)
    runs.value = result.value
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    loading.value = false
    emit('refreshing', false)
  }
}

defineExpose({ refresh })
onMounted(() => void refresh())
</script>

<template>
  <div class="dashboard-widget-content">
    <div class="dashboard-widget-metrics" aria-label="自动化运行统计">
      <div>
        <strong>{{ counts.running }}</strong
        ><span>进行中</span>
      </div>
      <div>
        <strong>{{ counts.completed }}</strong
        ><span>已完成</span>
      </div>
      <div>
        <strong>{{ counts.failed }}</strong
        ><span>异常</span>
      </div>
    </div>
    <p v-if="loading" class="dashboard-widget-state">正在读取自动化运行记录…</p>
    <div v-else-if="error" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>读取失败</strong><span>{{ error }}</span
      ><button type="button" @click="refresh">重试</button>
    </div>
    <p v-else-if="!runs.length" class="dashboard-widget-state">还没有自动化运行记录。</p>
    <ul v-else class="dashboard-widget-list">
      <li v-for="run in runs.slice(0, limit)" :key="run.id">
        <span class="dashboard-status-dot" :class="`dashboard-status-dot--${run.status}`" />
        <span class="dashboard-widget-list__main">
          <strong>{{ run.automationName || '手动自动化' }}</strong>
          <small>{{ new Date(run.queuedAt).toLocaleString() }}</small>
        </span>
        <em>{{ statusLabels[run.status] }}</em>
      </li>
    </ul>
  </div>
</template>
