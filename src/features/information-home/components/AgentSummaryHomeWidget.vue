<script setup lang="ts">
import { ArrowUpRight, Mail } from '@lucide/vue'
import { computed } from 'vue'

import type { InformationHomeSummary } from '@/models/home/informationHome'
import { renderAiMarkdown } from '@/services/ai/AiMarkdownRenderer'
import { buildSignalResultDigest } from '@/services/home/SignalResultDigestService'

const props = defineProps<{
  summaries: InformationHomeSummary[]
  generating: boolean
  autoEnabled: boolean
  intervalMinutes: number
}>()
const emit = defineEmits<{
  generate: []
  toggleAuto: []
  changeInterval: []
  openEmail: [id: string]
}>()
const digest = computed(() => buildSignalResultDigest(props.summaries))
const rendered = computed(() => renderAiMarkdown(digest.value.narrativeMarkdown))
</script>

<template>
  <div class="dashboard-widget-content home-agent-summary">
    <header>
      <div>
        <strong>事件驱动处理</strong>
        <small>汇总系统事件的处理结果，并保留邮件等原始条目的定位入口。</small>
      </div>
      <div>
        <button
          type="button"
          :class="{ 'is-active': autoEnabled }"
          :aria-pressed="autoEnabled"
          @click="emit('toggleAuto')"
        >
          自动摘要 {{ autoEnabled ? '已开' : '已关' }}
        </button>
        <button type="button" title="调整自动摘要间隔" @click="emit('changeInterval')">
          {{
            intervalMinutes >= 1440
              ? `${Math.round(intervalMinutes / 1440)} 天`
              : `${intervalMinutes} 分钟`
          }}
        </button>
        <button type="button" :disabled="generating" @click="emit('generate')">
          {{ generating ? '已提交…' : '处理相关更新' }}
        </button>
      </div>
    </header>
    <p
      v-if="digest.latestResult?.status === 'failed'"
      class="dashboard-widget-state dashboard-widget-state--error"
    >
      {{ digest.latestResult.error }}
    </p>
    <div
      v-else-if="digest.primaryResult || digest.emailBriefs.length"
      class="home-agent-summary__content"
    >
      <div class="home-agent-summary__meta">
        <span
          >已消费 {{ digest.completedCount }} 次事件处理 ·
          {{ digest.primaryResult?.triggerSource === 'auto' ? 'AUTO' : 'MANUAL' }}</span
        ><time v-if="digest.primaryResult">{{
          new Date(digest.primaryResult.generatedAt).toLocaleString()
        }}</time>
      </div>
      <!-- renderAiMarkdown escapes text and filters link protocols before returning HTML. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="digest.narrativeMarkdown" class="markdown-preview" v-html="rendered"></div>
      <section v-if="digest.emailBriefs.length" class="home-agent-summary__email-briefs">
        <header>
          <strong><Mail :size="14" />邮件简报</strong
          ><small>{{ digest.emailBriefs.length }} 条</small>
        </header>
        <button
          v-for="item in digest.emailBriefs"
          :key="item.messageId"
          type="button"
          @click="emit('openEmail', item.messageId)"
        >
          <span
            ><strong>{{ item.title }}</strong
            ><small>{{ item.summary }}</small></span
          >
          <ArrowUpRight :size="14" />
        </button>
      </section>
    </div>
    <p v-else class="dashboard-widget-state">
      尚无系统事件处理结果。新邮件、RSS 或手动处理完成后会自动汇总到这里。
    </p>
  </div>
</template>
