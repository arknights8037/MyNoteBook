<script setup lang="ts">
import { Activity, RefreshCw, Server, TriangleAlert } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { createAgentCommunicationRepository } from '@/infrastructure/database/agent/agentCommunicationRepositoryFactory'
import {
  getAgentWorkerSnapshot,
  subscribeAgentWorkerSnapshot,
  type AgentWorkerSnapshot,
} from '@/infrastructure/runtime/AgentWorkerSnapshotClient'
import {
  listenAgentRequestQueue,
  type AgentRequestQueueSnapshot,
} from '@/infrastructure/runtime/TauriAgentCommunicationWatcher'
import type { AgentCommunicationRequest } from '@/repositories/agent/AgentCommunicationRepository'
import { NButton, NIcon, NTooltip } from '@/ui'

type SubscribeSnapshot = (listener: (snapshot: AgentWorkerSnapshot) => void) => Promise<() => void>
type SubscribeQueue = (
  listener: (snapshot: AgentRequestQueueSnapshot) => void,
) => Promise<() => void>

let requestsLoader: Promise<() => Promise<AgentCommunicationRequest[]>> | null = null

async function loadRecentRequests(): Promise<AgentCommunicationRequest[]> {
  requestsLoader ??= createAgentCommunicationRepository().then(
    (repository) => () => repository.listRecent(40),
  )
  return (await requestsLoader)()
}

const props = defineProps<{
  getSnapshot?: () => Promise<AgentWorkerSnapshot>
  getRequests?: () => Promise<AgentCommunicationRequest[]>
  subscribeSnapshot?: SubscribeSnapshot
  subscribeQueue?: SubscribeQueue
}>()

const snapshot = ref<AgentWorkerSnapshot | null>(null)
const requests = ref<AgentCommunicationRequest[]>([])
const loading = ref(false)
const error = ref('')
const unlisteners: Array<() => void> = []

const visibleRequests = computed(() => requests.value.slice(0, 12))
const deadLetterCount = computed(
  () => requests.value.filter((request) => request.deadLetteredAt !== null).length,
)
const retryCount = computed(
  () => requests.value.filter((request) => request.nextAttemptAt !== null).length,
)

const workerLabels: Record<AgentWorkerSnapshot['status'], string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行正常',
  restarting: '重启中',
  crashed: '已崩溃',
  unavailable: '不可用',
}
const requestLabels: Record<AgentCommunicationRequest['status'], string> = {
  queued: '排队中',
  running: '运行中',
  awaiting_review: '等待审阅',
  approved: '已批准',
  rejected: '已拒绝',
  completed: '已完成',
  failed: '失败',
}
const modeLabels: Record<AgentCommunicationRequest['mode'], string> = {
  agent: 'Agent',
  research: 'Research',
  review: 'Review',
  learning: 'Learning',
}
const failureLabels: Record<string, string> = {
  retryable: '可重试故障',
  startup_recovery: '启动恢复',
  interrupted: '运行中断',
  worker_crash: 'Worker 异常退出',
}

async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const [nextSnapshot, nextRequests] = await Promise.all([
      (props.getSnapshot ?? getAgentWorkerSnapshot)(),
      (props.getRequests ?? loadRecentRequests)(),
    ])
    snapshot.value = nextSnapshot
    requests.value = nextRequests
  } catch (refreshError) {
    error.value = refreshError instanceof Error ? refreshError.message : String(refreshError)
  } finally {
    loading.value = false
  }
}

function formatTime(value: number | null): string {
  return value === null ? '时间未知' : new Date(value).toLocaleString()
}

function shortId(value: string | null): string {
  if (!value) return '未绑定'
  const segments = value.split('-')
  return (segments.at(-1) || value).slice(0, 8)
}

function requestStatus(request: AgentCommunicationRequest): string {
  if (request.deadLetteredAt !== null) return '死信'
  if (request.nextAttemptAt !== null) return '等待重试'
  return requestLabels[request.status]
}

function requestStatusClass(request: AgentCommunicationRequest): string {
  if (request.deadLetteredAt !== null) return 'dead-letter'
  if (request.nextAttemptAt !== null) return 'retrying'
  return request.status
}

function requestFailure(request: AgentCommunicationRequest): string | null {
  if (!request.lastFailureKind && !request.error) return null
  const kind = request.lastFailureKind
    ? (failureLabels[request.lastFailureKind] ?? request.lastFailureKind)
    : '执行失败'
  return request.error ? `${kind}：${request.error}` : kind
}

onMounted(async () => {
  await refresh()
  const subscriptions = await Promise.allSettled([
    (props.subscribeSnapshot ?? subscribeAgentWorkerSnapshot)((nextSnapshot) => {
      snapshot.value = nextSnapshot
    }),
    (props.subscribeQueue ?? listenAgentRequestQueue)(() => void refresh()),
  ])
  for (const subscription of subscriptions) {
    if (subscription.status === 'fulfilled') unlisteners.push(subscription.value)
  }
})

onBeforeUnmount(() => {
  for (const unlisten of unlisteners.splice(0)) unlisten()
})
</script>

<template>
  <section class="p1-domain-card agent-runtime-operations">
    <header>
      <Activity :size="18" />
      <div>
        <h2>后台运行控制</h2>
        <p>Worker、活动运行与 A2A 可靠性状态</p>
      </div>
      <NTooltip>
        <template #trigger>
          <NButton
            class="agent-runtime-operations__refresh"
            size="small"
            quaternary
            circle
            :loading="loading"
            aria-label="刷新后台运行状态"
            @click="refresh"
          >
            <template #icon
              ><NIcon :size="15"><RefreshCw /></NIcon
            ></template>
          </NButton>
        </template>
        刷新状态
      </NTooltip>
    </header>

    <p v-if="error" class="operations-error" role="alert">{{ error }}</p>

    <div class="agent-runtime-summary" aria-label="后台运行摘要">
      <div class="agent-runtime-summary__worker">
        <Server :size="16" />
        <span>Worker</span>
        <strong :class="`is-${snapshot?.status ?? 'stopped'}`">
          {{ snapshot ? workerLabels[snapshot.status] : '读取中' }}
        </strong>
        <small v-if="snapshot">
          心跳 {{ formatTime(snapshot.lastHeartbeatAt) }} · 重启 {{ snapshot.restartCount }} 次
        </small>
      </div>
      <div>
        <span>活动 Run</span><strong>{{ snapshot?.activeRuns.length ?? 0 }}</strong>
      </div>
      <div>
        <span>待授权</span><strong>{{ snapshot?.pendingAuthorizations.length ?? 0 }}</strong>
      </div>
      <div>
        <span>待领取终态</span><strong>{{ snapshot?.pendingTerminals.length ?? 0 }}</strong>
      </div>
      <div>
        <span>等待重试</span><strong>{{ retryCount }}</strong>
      </div>
      <div :class="{ 'has-alert': deadLetterCount > 0 }">
        <span>死信</span><strong>{{ deadLetterCount }}</strong>
      </div>
    </div>

    <div v-if="snapshot?.lastError" class="agent-runtime-alert">
      <TriangleAlert :size="15" />
      <span>{{ snapshot.lastError }}</span>
    </div>

    <div v-if="snapshot?.activeRuns.length" class="agent-runtime-active-runs">
      <strong>当前运行</strong>
      <span v-for="run in snapshot.activeRuns" :key="run.runId" :title="run.runId">
        {{ run.objective }} · Run #{{ shortId(run.runId) }}
      </span>
    </div>

    <div class="agent-request-list">
      <article v-for="request in visibleRequests" :key="request.id" class="agent-request-row">
        <div class="agent-request-row__main">
          <strong>{{ request.prompt }}</strong>
          <small>
            {{ modeLabels[request.mode] }} · 请求 #{{ shortId(request.id) }} · Run #{{
              shortId(request.runId)
            }}
            · 第 {{ request.attemptCount }} 次尝试
          </small>
          <small v-if="request.nextAttemptAt !== null">
            下次尝试 {{ formatTime(request.nextAttemptAt) }}
          </small>
          <small v-else-if="request.deadLetteredAt !== null">
            {{ formatTime(request.deadLetteredAt) }} 进入死信
          </small>
          <small v-if="requestFailure(request)" class="agent-request-row__error">
            {{ requestFailure(request) }}
          </small>
        </div>
        <span class="audit-status" :class="`audit-status--${requestStatusClass(request)}`">
          {{ requestStatus(request) }}
        </span>
      </article>
      <p v-if="!visibleRequests.length && !loading" class="operations-empty">暂无 A2A 请求记录。</p>
    </div>
  </section>
</template>
