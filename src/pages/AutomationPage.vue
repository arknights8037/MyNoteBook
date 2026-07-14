<script setup lang="ts">
import { CalendarClock, CirclePlay, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import { createAutomationRepository } from '@/infrastructure/database/automationRepositoryFactory'
import type { AutomationRun, AutomationTask, AutomationTriggerType } from '@/models/automation'
import { createEntityId } from '@/models/id'
import { AutomationService } from '@/services/AutomationService'
import { NButton, NIcon, NSelect } from '@/ui'

const props = defineProps<{
  currentDocumentId: string
  currentDocumentTitle: string
}>()

const tasks = ref<AutomationTask[]>([])
const runs = ref<AutomationRun[]>([])
const loading = ref(false)
const error = ref('')
const draftName = ref('')
const draftInstruction = ref('')
const draftTrigger = ref<AutomationTriggerType>('manual')
const draftIntervalMinutes = ref(60)
const draftDailyTime = ref('09:00')
const bindCurrentDocument = ref(true)
let servicePromise: Promise<AutomationService> | null = null
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const enabledCount = computed(() => tasks.value.filter((task) => task.enabled).length)
const queuedCount = computed(() => runs.value.filter((run) => run.status === 'queued').length)
const triggerOptions = [
  { label: '手动触发', value: 'manual' },
  { label: '按间隔', value: 'interval' },
  { label: '每天定时', value: 'daily' },
]

async function getService(): Promise<AutomationService> {
  servicePromise ??= createAutomationRepository().then(
    (repository) => new AutomationService(repository, createEntityId),
  )
  return servicePromise
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const service = await getService()
    const [taskResult, runResult] = await Promise.all([service.listTasks(), service.listRuns(30)])
    if (!taskResult.ok) throw new Error(taskResult.error.message)
    if (!runResult.ok) throw new Error(runResult.error.message)
    tasks.value = taskResult.value
    runs.value = runResult.value
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  } finally {
    loading.value = false
  }
}

async function createTask(): Promise<void> {
  if (!draftName.value.trim() || !draftInstruction.value.trim()) {
    error.value = '请输入自动化名称和任务指令。'
    return
  }
  loading.value = true
  error.value = ''
  const triggerConfig =
    draftTrigger.value === 'interval'
      ? { intervalMinutes: draftIntervalMinutes.value }
      : draftTrigger.value === 'daily'
        ? { dailyTime: draftDailyTime.value }
        : {}
  const result = await (
    await getService()
  ).createTask({
    name: draftName.value,
    instruction: draftInstruction.value,
    triggerType: draftTrigger.value,
    triggerConfig,
    documentId: bindCurrentDocument.value ? props.currentDocumentId : null,
  })
  loading.value = false
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  draftName.value = ''
  draftInstruction.value = ''
  await load()
}

async function toggleTask(task: AutomationTask, event: BrowserEvent): Promise<void> {
  const enabled = (event.target as BrowserInputElement).checked
  const result = await (await getService()).setTaskEnabled(task, enabled)
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  await load()
}

async function enqueueTask(task: AutomationTask): Promise<void> {
  const result = await (await getService()).enqueueTask(task)
  if (!result.ok) error.value = result.error.message
  await load()
}

async function deleteTask(task: AutomationTask): Promise<void> {
  if (!globalThis.confirm(`删除自动化“${task.name}”？历史运行记录会保留。`)) return
  const result = await (await getService()).deleteTask(task.id)
  if (!result.ok) error.value = result.error.message
  await load()
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : '未安排'
}

function triggerLabel(task: AutomationTask): string {
  if (task.triggerType === 'interval') return `每 ${task.triggerConfig.intervalMinutes} 分钟`
  if (task.triggerType === 'daily') return `每天 ${task.triggerConfig.dailyTime}`
  return '手动触发'
}

function runStatusLabel(status: AutomationRun['status']): string {
  return {
    queued: '等待执行器',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }[status]
}

onMounted(load)
</script>

<template>
  <section class="operations-page" aria-label="自动化任务">
    <header class="operations-page__header">
      <div>
        <span class="operations-page__eyebrow"><CalendarClock :size="15" />AUTOMATIONS</span>
        <h1>自动化任务</h1>
        <p>{{ enabledCount }} 个已启用 · {{ queuedCount }} 个等待执行</p>
      </div>
      <NButton secondary :loading="loading" @click="load">
        <template #icon
          ><NIcon :size="15"><RefreshCw /></NIcon
        ></template>
        刷新
      </NButton>
    </header>

    <div class="operations-page__content">
      <section class="automation-compose" aria-label="新建自动化">
        <div class="operations-section-heading">
          <strong>新建任务</strong><span>定义会写入本地队列</span>
        </div>
        <div class="automation-compose__grid">
          <label>
            <span>名称</span>
            <input v-model="draftName" type="text" placeholder="例如：每日整理行动项" />
          </label>
          <label>
            <span>触发方式</span>
            <NSelect v-model:value="draftTrigger" :options="triggerOptions" />
          </label>
          <label v-if="draftTrigger === 'interval'">
            <span>间隔分钟</span>
            <input v-model.number="draftIntervalMinutes" type="number" min="5" max="10080" />
          </label>
          <label v-if="draftTrigger === 'daily'">
            <span>运行时间</span>
            <input v-model="draftDailyTime" type="time" />
          </label>
          <label class="automation-compose__instruction">
            <span>任务指令</span>
            <textarea
              v-model="draftInstruction"
              rows="3"
              placeholder="描述执行器领取任务后需要完成的工作"
            ></textarea>
          </label>
        </div>
        <footer>
          <label class="operations-check">
            <input v-model="bindCurrentDocument" type="checkbox" />
            <span>绑定当前页面：{{ currentDocumentTitle || '未命名页面' }}</span>
          </label>
          <NButton type="primary" :loading="loading" @click="createTask">
            <template #icon
              ><NIcon :size="15"><Plus /></NIcon
            ></template>
            创建
          </NButton>
        </footer>
      </section>

      <p v-if="error" class="operations-error" role="alert">{{ error }}</p>

      <section aria-label="自动化定义">
        <div class="operations-section-heading">
          <strong>任务定义</strong><span>{{ tasks.length }} 项</span>
        </div>
        <div v-if="tasks.length === 0" class="operations-empty">暂无自动化任务</div>
        <article v-for="task in tasks" :key="task.id" class="automation-row">
          <label class="operations-switch" :title="task.enabled ? '停用' : '启用'">
            <input type="checkbox" :checked="task.enabled" @change="toggleTask(task, $event)" />
            <span aria-hidden="true"></span>
          </label>
          <div class="automation-row__body">
            <header>
              <strong>{{ task.name }}</strong>
              <span :class="task.enabled ? 'status-success' : 'status-muted'">
                {{ task.enabled ? '已启用' : '已停用' }}
              </span>
            </header>
            <p>{{ task.instruction }}</p>
            <small>{{ triggerLabel(task) }} · 下次：{{ formatTime(task.nextRunAt) }}</small>
          </div>
          <div class="automation-row__actions">
            <NButton size="small" secondary :disabled="!task.enabled" @click="enqueueTask(task)">
              <template #icon
                ><NIcon :size="14"><CirclePlay /></NIcon
              ></template>
              入队
            </NButton>
            <NButton
              size="small"
              quaternary
              circle
              aria-label="删除自动化"
              @click="deleteTask(task)"
            >
              <template #icon
                ><NIcon :size="14"><Trash2 /></NIcon
              ></template>
            </NButton>
          </div>
        </article>
      </section>

      <section aria-label="最近运行">
        <div class="operations-section-heading">
          <strong>最近运行</strong><span>{{ runs.length }} 条</span>
        </div>
        <div v-if="runs.length === 0" class="operations-empty">暂无运行记录</div>
        <div v-for="run in runs" :key="run.id" class="automation-run-row">
          <span :class="`audit-status audit-status--${run.status}`">{{
            runStatusLabel(run.status)
          }}</span>
          <strong>{{ run.automationName || '已删除的自动化' }}</strong>
          <small>{{ run.triggerSource }} · {{ formatTime(run.queuedAt) }}</small>
          <code>{{ run.id }}</code>
        </div>
      </section>
    </div>
  </section>
</template>
