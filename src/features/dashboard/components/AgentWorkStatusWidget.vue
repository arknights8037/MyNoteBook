<script setup lang="ts">
import { computed } from 'vue'

import type { AgentTask, AgentTaskStatus } from '@/models/agent/agent'

const props = defineProps<{
  tasks: AgentTask[]
  limit: number
  showCompleted: boolean
}>()

const visibleTasks = computed(() =>
  [...props.tasks]
    .filter((task) => props.showCompleted || task.status !== 'completed')
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, props.limit),
)
const counts = computed(() => ({
  active: props.tasks.filter((task) => task.status === 'running' || task.status === 'pending')
    .length,
  waiting: props.tasks.filter((task) => task.status === 'waiting_confirmation').length,
  failed: props.tasks.filter((task) => task.status === 'failed').length,
}))
const statusLabels: Record<AgentTaskStatus, string> = {
  pending: '准备中',
  running: '执行中',
  waiting_confirmation: '等待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
</script>

<template>
  <div class="dashboard-widget-content">
    <div class="dashboard-widget-metrics" aria-label="Agent 任务统计">
      <div>
        <strong>{{ counts.active }}</strong
        ><span>进行中</span>
      </div>
      <div>
        <strong>{{ counts.waiting }}</strong
        ><span>待确认</span>
      </div>
      <div>
        <strong>{{ counts.failed }}</strong
        ><span>异常</span>
      </div>
    </div>
    <p v-if="!visibleTasks.length" class="dashboard-widget-state">当前没有 Agent 工作记录。</p>
    <ul v-else class="dashboard-widget-list">
      <li v-for="task in visibleTasks" :key="task.id">
        <span class="dashboard-status-dot" :class="`dashboard-status-dot--${task.status}`" />
        <span class="dashboard-widget-list__main">
          <strong>{{ task.userInstruction }}</strong>
          <small>{{ task.currentStep || new Date(task.createdAt).toLocaleString() }}</small>
        </span>
        <em>{{ statusLabels[task.status] }}</em>
      </li>
    </ul>
  </div>
</template>
