<script setup lang="ts">
import { ClipboardList, RefreshCw, Search } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import type { AuditCategory, AuditEntry } from '@/models/shared/audit'
import type { AuditRepository } from '@/repositories/audit/AuditRepository'
import { NButton, NIcon, NSelect } from '@/ui'

const props = withDefaults(defineProps<{
  getRepository: () => Promise<AuditRepository>
  contextNavigation?: boolean
}>(), { contextNavigation: false })

const entries = ref<AuditEntry[]>([])
const category = defineModel<AuditCategory | 'all'>('category', { default: 'all' })
const search = ref('')
const loading = ref(false)
const error = ref('')

const categoryOptions = [
  { label: '全部类型', value: 'all' },
  { label: 'Agent 任务', value: 'agent_task' },
  { label: '工具调用', value: 'tool_call' },
  { label: '确认事件', value: 'confirmation' },
  { label: '自动化运行', value: 'automation_run' },
  { label: '统一任务', value: 'task_run' },
  { label: '知识对象', value: 'knowledge' },
  { label: '结果验证', value: 'verification' },
  { label: 'ChangeSet', value: 'change_set' },
  { label: '审批', value: 'approval' },
  { label: 'View 刷新', value: 'view_refresh' },
  { label: '外部委派', value: 'delegation' },
  { label: '领域事件', value: 'domain_event' },
  { label: 'Outbox', value: 'outbox' },
]
const errorCount = computed(
  () => entries.value.filter((entry) => entry.severity === 'error').length,
)
const activeCount = computed(
  () =>
    entries.value.filter((entry) =>
      ['running', 'queued', 'waiting_confirmation', 'waiting_approval', 'blocked'].includes(entry.status),
    ).length,
)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  const result = await (
    await props.getRepository()
  ).listEntries({ category: category.value, search: search.value, limit: 300 })
  loading.value = false
  if (!result.ok) {
    error.value = result.error.message
    return
  }
  entries.value = result.value
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

function categoryLabel(value: AuditCategory): string {
  return {
    agent_task: 'Agent 任务',
    tool_call: '工具调用',
    confirmation: '确认事件',
    automation_run: '自动化',
    task_run: '统一任务',
    knowledge: '知识对象',
    verification: '结果验证',
    change_set: 'ChangeSet',
    approval: '审批',
    view_refresh: 'View 刷新',
    delegation: '外部委派',
    domain_event: '领域事件',
    outbox: 'Outbox',
  }[value]
}

function formatDetails(value: string | null): string {
  if (!value) return '无附加详情'
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

onMounted(load)
watch(category, () => void load())
</script>

<template>
  <section class="operations-page" aria-label="审计记录">
    <header class="operations-page__header">
      <div>
        <span class="operations-page__eyebrow"><ClipboardList :size="15" />AUDIT</span>
        <h1>审计记录</h1>
        <p>{{ entries.length }} 条记录 · {{ activeCount }} 条进行中 · {{ errorCount }} 条异常</p>
      </div>
      <NButton secondary :loading="loading" @click="load">
        <template #icon
          ><NIcon :size="15"><RefreshCw /></NIcon
        ></template>
        刷新
      </NButton>
    </header>

    <div class="operations-page__content">
      <aside class="surface-guide">
        <ClipboardList :size="18" />
        <div>
          <strong>这里是只读的操作记录</strong>
          <p>遇到任务失败或行为不符合预期时，先按类型筛选，再点击一条记录查看详细信息。</p>
        </div>
      </aside>
      <div class="audit-toolbar">
        <label class="audit-search">
          <Search :size="15" />
          <input
            v-model="search"
            type="search"
            placeholder="搜索标题、状态或摘要"
            @keyup.enter="load"
          />
        </label>
        <NSelect v-if="!contextNavigation" v-model:value="category" :options="categoryOptions" @update:value="load" />
      </div>
      <p v-if="error" class="operations-error" role="alert">{{ error }}</p>
      <div class="audit-table" role="table" aria-label="审计事件列表">
        <div class="audit-table__head" role="row">
          <span>时间</span><span>类型</span><span>事件</span><span>状态</span>
        </div>
        <div v-if="entries.length === 0" class="operations-empty">暂无匹配记录</div>
        <details v-for="entry in entries" :key="entry.id" class="audit-row">
          <summary>
            <time>{{ formatTime(entry.createdAt) }}</time>
            <span>{{ categoryLabel(entry.category) }}</span>
            <span class="audit-row__event"
              ><strong>{{ entry.title }}</strong
              ><small>{{ entry.summary }}</small></span
            >
            <span :class="`audit-status audit-status--${entry.severity}`">{{ entry.status }}</span>
          </summary>
          <div class="audit-row__details">
            <dl>
              <dt>事件 ID</dt>
              <dd>
                <code>{{ entry.id }}</code>
              </dd>
              <dt>实体 ID</dt>
              <dd>
                <code>{{ entry.entityId }}</code>
              </dd>
            </dl>
            <pre>{{ formatDetails(entry.detailsJson) }}</pre>
          </div>
        </details>
      </div>
    </div>
  </section>
</template>
