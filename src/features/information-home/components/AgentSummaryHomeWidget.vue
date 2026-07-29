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

function intervalLabel(): string {
  if (props.intervalMinutes >= 1440) return `${Math.round(props.intervalMinutes / 1440)} 天`
  if (props.intervalMinutes >= 60) return `${Math.round(props.intervalMinutes / 60)} 小时`
  return `${props.intervalMinutes} 分钟`
}
</script>

<template>
  <div class="dashboard-widget-content home-agent-summary">
    <header>
      <div>
        <strong>{{
          autoEnabled ? `自动整理 · 最短间隔 ${intervalLabel()}` : '手动生成模式'
        }}</strong>
        <small>邮件和 RSS 作为不可信只读材料，不会触发工具或写入。</small>
      </div>
      <div>
        <button type="button" @click="emit('toggleAuto')">
          {{ autoEnabled ? '关闭自动摘要' : '开启自动摘要' }}
        </button>
        <button v-if="autoEnabled" type="button" @click="emit('changeInterval')">调整间隔</button>
        <button type="button" :disabled="generating" @click="emit('generate')">
          {{ generating ? '生成中…' : '立即总结' }}
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
    <p v-else class="dashboard-widget-state">尚未生成首页摘要。开启自动摘要或手动运行一次。</p>
  </div>
</template>
