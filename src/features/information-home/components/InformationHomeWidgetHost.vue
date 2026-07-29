<script setup lang="ts">
import { Scaling } from '@lucide/vue'
import { computed, onErrorCaptured, ref } from 'vue'

import type { InformationHomeSummary, InformationHomeWidget } from '@/models/home/informationHome'
import DashboardWidgetFrame from '@/features/dashboard/components/DashboardWidgetFrame.vue'
import { getInformationHomeWidgetDefinition } from '../informationHomeWidgetRegistry'
import AgentSummaryHomeWidget from './AgentSummaryHomeWidget.vue'
import EmailActionsHomeWidget from './EmailActionsHomeWidget.vue'
import RssNewsHomeWidget from './RssNewsHomeWidget.vue'

const props = defineProps<{
  widget: InformationHomeWidget
  editing: boolean
  summary: InformationHomeSummary | null
  generatingSummary: boolean
  autoSummaryEnabled: boolean
  summaryIntervalMinutes: number
}>()
const emit = defineEmits<{
  copy: []
  remove: []
  openEmail: []
  openRss: []
  generateSummary: []
  toggleAutoSummary: []
  changeSummaryInterval: []
  resize: []
}>()

const emailWidget = ref<InstanceType<typeof EmailActionsHomeWidget> | null>(null)
const rssWidget = ref<InstanceType<typeof RssNewsHomeWidget> | null>(null)
const refreshing = ref(false)
const renderError = ref('')
const definition = computed(() => getInformationHomeWidgetDefinition(props.widget.widgetType))
const title = computed(() => props.widget.settings.title || definition.value.title)

onErrorCaptured((error) => {
  renderError.value = error instanceof Error ? error.message : String(error)
  return false
})

function refresh(): void {
  renderError.value = ''
  if (props.widget.widgetType === 'email-actions') void emailWidget.value?.refresh()
  if (props.widget.widgetType === 'rss-news') void rssWidget.value?.refresh()
}
</script>

<template>
  <DashboardWidgetFrame
    :title="title"
    :source="definition.source"
    :editing="editing"
    :refreshing="refreshing"
    :refreshable="widget.widgetType !== 'agent-summary'"
    @copy="emit('copy')"
    @remove="emit('remove')"
    @refresh="refresh"
  >
    <template v-if="editing" #actions>
      <button type="button" aria-label="切换卡片尺寸" title="切换尺寸预设" @click="emit('resize')">
        <Scaling :size="15" />
      </button>
    </template>
    <div v-if="renderError" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>模块渲染失败</strong><span>{{ renderError }}</span
      ><button type="button" @click="refresh">重试</button>
    </div>
    <EmailActionsHomeWidget
      v-else-if="widget.widgetType === 'email-actions'"
      ref="emailWidget"
      :limit="widget.query.limit"
      @open="emit('openEmail')"
      @refreshing="refreshing = $event"
    />
    <RssNewsHomeWidget
      v-else-if="widget.widgetType === 'rss-news'"
      ref="rssWidget"
      :limit="widget.query.limit"
      @open="emit('openRss')"
      @refreshing="refreshing = $event"
    />
    <AgentSummaryHomeWidget
      v-else
      :summary="summary"
      :generating="generatingSummary"
      :auto-enabled="autoSummaryEnabled"
      :interval-minutes="summaryIntervalMinutes"
      @generate="emit('generateSummary')"
      @toggle-auto="emit('toggleAutoSummary')"
      @change-interval="emit('changeSummaryInterval')"
    />
  </DashboardWidgetFrame>
</template>
