<script setup lang="ts">
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { onBeforeUnmount, onMounted } from 'vue'

import { createAutomationServiceProvider } from '@/app/composition/surfaceServiceProviders'
import type { AutomationRun } from '@/models/automation/automation'
import { useMessage } from '@/ui/services'

interface AutomationQueueSnapshot {
  latestUpdateAt?: number | null
}

const native = Reflect.has(globalThis, '__TAURI_INTERNALS__')
const notify = useMessage()
const getService = createAutomationServiceProvider()
const knownStatuses = new Map<string, AutomationRun['status']>()
const mountedAt = Date.now()
let lastSnapshotUpdateAt = 0
let unlistenQueue: UnlistenFn | null = null
let ready = false
let pendingEvent = false
let refreshing = false
let refreshRequested = false

async function refresh(announce: boolean): Promise<void> {
  if (refreshing) {
    refreshRequested = true
    return
  }
  refreshing = true
  try {
    do {
      refreshRequested = false
      const result = await (await getService()).listRuns(100)
      if (!result.ok) return
      consumeRuns(result.value, announce)
      announce = true
    } while (refreshRequested)
  } finally {
    refreshing = false
  }
}

function consumeRuns(runs: AutomationRun[], announce: boolean): void {
  const activeIds = new Set(runs.map((run) => run.id))
  for (const id of knownStatuses.keys()) {
    if (!activeIds.has(id)) knownStatuses.delete(id)
  }
  for (const run of [...runs].reverse()) {
    const previous = knownStatuses.get(run.id)
    const changed = previous !== run.status
    const occurredAt = run.completedAt ?? run.startedAt ?? run.queuedAt
    if (announce && changed && (previous !== undefined || occurredAt >= mountedAt)) {
      announceRun(run)
    }
    knownStatuses.set(run.id, run.status)
    lastSnapshotUpdateAt = Math.max(lastSnapshotUpdateAt, occurredAt)
  }
}

function announceRun(run: AutomationRun): void {
  const name = run.automationName?.trim() || '自动化任务'
  if (run.status === 'completed') {
    const summary = compactText(readRunSummary(run), 96)
    notify.success(`自动化“${name}”已完成${summary ? `：${summary}` : ''}`)
    return
  }
  if (run.status === 'waiting_approval') {
    const warn = notify.warning ?? notify.success
    warn(`自动化“${name}”已生成结果，正在等待你的确认`)
    return
  }
  if (run.status === 'failed') {
    const error = compactText(run.error || '后台 Agent 未能完成任务。', 96)
    notify.error(`自动化“${name}”运行失败：${error}`)
  }
}

function readRunSummary(run: AutomationRun): string {
  if (!run.outputJson) return ''
  try {
    const parsed = JSON.parse(run.outputJson) as { summary?: unknown }
    return typeof parsed.summary === 'string' ? parsed.summary : ''
  } catch {
    return ''
  }
}

function compactText(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

onMounted(async () => {
  if (!native) return
  unlistenQueue = await listen<AutomationQueueSnapshot>(
    'automation://queue-changed',
    ({ payload }) => {
      const updateAt = payload.latestUpdateAt ?? 0
      if (updateAt && updateAt <= lastSnapshotUpdateAt) return
      if (!ready) {
        pendingEvent = true
        return
      }
      if (updateAt) lastSnapshotUpdateAt = updateAt
      void refresh(true)
    },
  )
  await refresh(false)
  ready = true
  if (pendingEvent) {
    pendingEvent = false
    await refresh(true)
  }
})

onBeforeUnmount(() => unlistenQueue?.())
</script>

<template>
  <span class="automation-notification-bridge" aria-hidden="true" hidden></span>
</template>
