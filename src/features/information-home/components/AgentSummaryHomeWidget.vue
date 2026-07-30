<script setup lang="ts">
import { computed } from 'vue'

import type { InformationHomeSummary } from '@/models/home/informationHome'
import { renderAiMarkdown } from '@/services/ai/AiMarkdownRenderer'

const props = defineProps<{
  summary: InformationHomeSummary | null
  generating: boolean
  autoEnabled: boolean
  intervalMinutes: number
}>()
const emit = defineEmits<{ generate: []; toggleAuto: []; changeInterval: [] }>()
const rendered = computed(() => renderAiMarkdown(props.summary?.content ?? ''))
</script>

<template>
  <div class="dashboard-widget-content home-agent-summary">
    <header>
      <div>
        <strong>事件驱动处理</strong>
        <small>Agent 自主核对邮件、会议与知识库，只写入本地待办和日历。</small>
      </div>
      <div>
        <button type="button" :disabled="generating" @click="emit('generate')">
          {{ generating ? '已提交…' : '处理相关更新' }}
        </button>
      </div>
    </header>
    <p
      v-if="summary?.status === 'failed'"
      class="dashboard-widget-state dashboard-widget-state--error"
    >
      {{ summary.error }}
    </p>
    <div v-else-if="summary" class="home-agent-summary__content">
      <div class="home-agent-summary__meta">
        <span
          >{{ summary.triggerSource === 'auto' ? 'AUTO' : 'MANUAL' }} · {{ summary.provider }} /
          {{ summary.model || '默认模型' }}</span
        ><time>{{ new Date(summary.generatedAt).toLocaleString() }}</time>
      </div>
      <!-- renderAiMarkdown escapes text and filters link protocols before returning HTML. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="markdown-preview" v-html="rendered"></div>
    </div>
    <p v-else class="dashboard-widget-state">
      尚未处理相关更新。点击后由 Agent 自主决定摘要、待办、日程和冲突核对。
    </p>
  </div>
</template>
