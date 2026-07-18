<script setup lang="ts">
import { CheckCircle2, ShieldCheck, SquareTerminal } from '@lucide/vue'
import type { TaskRun } from '@/models/work'
import { NButton, NIcon } from '@/ui'

defineProps<{
  taskRuns: TaskRun[]
  loading: boolean
  delegationGrant: string
  hasActiveGrant: boolean
  exportPath: string
  submissionPath: string
  capabilityToken: string
}>()
const emit = defineEmits<{
  verify: [run: TaskRun]
  delegate: [run: TaskRun]
  export: []
  import: []
  'update:exportPath': [value: string]
  'update:submissionPath': [value: string]
  'update:capabilityToken': [value: string]
}>()

const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_input: '等待输入',
  waiting_approval: '等待审批',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '已超时',
  stale: '已过期',
}

function shortRunId(id: string): string {
  return id.replace(/^taskrun-(?:agent-)?/, '').slice(0, 8)
}

function runSource(run: TaskRun): string {
  return run.taskDefinitionId ? `任务定义 ${run.taskDefinitionId.slice(0, 8)}` : '交互任务'
}
</script>

<template>
  <section class="p1-domain-card task-runs-panel">
    <header>
      <ShieldCheck :size="18" />
      <div>
        <h2>任务验收与外部协作</h2>
        <p>Agent 完成任务后仍需独立检查；也可以安全地委派给受限 CLI Agent。</p>
      </div>
    </header>
    <div class="p1-record-list">
      <article v-for="run in taskRuns" :key="run.id" class="task-run-row">
        <div class="task-run-row__identity">
          <strong :title="run.id">任务 #{{ shortRunId(run.id) }}</strong>
          <small>{{ runSource(run) }}</small>
        </div>
        <span class="audit-status" :class="`audit-status--${run.status}`">{{
          statusLabels[run.status] || run.status
        }}</span>
        <div class="task-run-row__actions">
          <NButton
            v-if="['running', 'blocked', 'waiting_approval'].includes(run.status)"
            size="small"
            secondary
            :loading="loading"
            @click="emit('verify', run)"
          >
            <template #icon
              ><NIcon :size="14"><CheckCircle2 /></NIcon
            ></template>
            验收
          </NButton>
          <NButton size="small" quaternary :loading="loading" @click="emit('delegate', run)">
            <template #icon
              ><NIcon :size="14"><SquareTerminal /></NIcon
            ></template>
            CLI 委派
          </NButton>
        </div>
      </article>
      <p v-if="taskRuns.length === 0" class="operations-empty">
        还没有待验收任务。运行 Agent 或自动化后，相关记录会出现在这里。
      </p>
      <pre v-if="delegationGrant">{{ delegationGrant }}</pre>
      <small v-if="delegationGrant">Capability token 只显示一次；数据库仅保存 SHA-256 hash。</small>
      <form v-if="hasActiveGrant" class="p1-view-form" @submit.prevent="emit('export')">
        <input
          :value="exportPath"
          placeholder="CLI envelope 导出绝对路径"
          @input="emit('update:exportPath', ($event.target as HTMLInputElement).value)"
        />
        <NButton secondary :disabled="!exportPath.trim()" @click="emit('export')"
          >导出 CLI Envelope</NButton
        >
      </form>
      <form class="p1-view-form" @submit.prevent="emit('import')">
        <input
          :value="submissionPath"
          placeholder="CLI submission JSON 绝对路径"
          @input="emit('update:submissionPath', ($event.target as HTMLInputElement).value)"
        />
        <input
          :value="capabilityToken"
          type="password"
          placeholder="Capability token"
          @input="emit('update:capabilityToken', ($event.target as HTMLInputElement).value)"
        />
        <NButton
          secondary
          :disabled="!submissionPath.trim() || !capabilityToken.trim()"
          @click="emit('import')"
          >导入外部提交</NButton
        >
      </form>
    </div>
  </section>
</template>
