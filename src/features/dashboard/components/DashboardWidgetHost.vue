<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue'

import type { AgentTask } from '@/models/agent/agent'
import type { DashboardWidgetInstance } from '@/models/workspace/workspaceView'
import type { AutomationService } from '@/services/automation/AutomationService'
import { getDashboardWidgetDefinition } from '../dashboardWidgetRegistry'
import AgentWorkStatusWidget from './AgentWorkStatusWidget.vue'
import AutomationResultsWidget from './AutomationResultsWidget.vue'
import DashboardWidgetFrame from './DashboardWidgetFrame.vue'

const props = defineProps<{
  widget: DashboardWidgetInstance
  editing: boolean
  agentTasks: AgentTask[]
  getAutomationService: () => Promise<AutomationService>
}>()
const emit = defineEmits<{ copy: []; remove: [] }>()

const automationWidget = ref<InstanceType<typeof AutomationResultsWidget> | null>(null)
const refreshing = ref(false)
const renderError = ref('')
const definition = computed(() => getDashboardWidgetDefinition(props.widget.widgetType))
const title = computed(() => props.widget.settings.title || definition.value.title)

onErrorCaptured((error) => {
  renderError.value = error instanceof Error ? error.message : String(error)
  return false
})

function refresh(): void {
  renderError.value = ''
  if (props.widget.widgetType === 'automation-results') void automationWidget.value?.refresh()
}
</script>

<template>
  <DashboardWidgetFrame
    :title="title"
    :source="definition.source"
    :editing="editing"
    :refreshing="refreshing"
    :refreshable="widget.widgetType === 'automation-results'"
    @copy="emit('copy')"
    @remove="emit('remove')"
    @refresh="refresh"
  >
    <div v-if="renderError" class="dashboard-widget-state dashboard-widget-state--error">
      <strong>组件渲染失败</strong><span>{{ renderError }}</span
      ><button type="button" @click="refresh">重试</button>
    </div>
    <AutomationResultsWidget
      v-else-if="widget.widgetType === 'automation-results'"
      ref="automationWidget"
      :get-service="getAutomationService"
      :limit="widget.query.limit ?? 8"
      @refreshing="refreshing = $event"
    />
    <AgentWorkStatusWidget
      v-else
      :tasks="agentTasks"
      :limit="widget.query.limit ?? 8"
      :show-completed="widget.settings.showCompleted !== false"
    />
  </DashboardWidgetFrame>
</template>
