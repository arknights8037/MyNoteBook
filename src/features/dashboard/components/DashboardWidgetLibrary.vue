<script setup lang="ts">
import { Plus, X } from '@lucide/vue'

import type { DashboardWidgetType } from '@/models/workspace/workspaceView'
import { DASHBOARD_WIDGET_REGISTRY } from '../dashboardWidgetRegistry'

const emit = defineEmits<{ add: [type: DashboardWidgetType]; close: [] }>()
</script>

<template>
  <aside class="dashboard-widget-library" aria-label="信息面板组件库">
    <header>
      <div><strong>组件库</strong><small>添加只读信息组件</small></div>
      <button type="button" aria-label="关闭组件库" @click="emit('close')"><X :size="17" /></button>
    </header>
    <button
      v-for="widget in DASHBOARD_WIDGET_REGISTRY"
      :key="widget.type"
      type="button"
      class="dashboard-widget-library__item"
      @click="emit('add', widget.type)"
    >
      <span
        ><strong>{{ widget.title }}</strong
        ><small>{{ widget.description }}</small></span
      >
      <Plus :size="17" />
    </button>
    <p>组件只能读取已登记的数据源，不会在面板内执行写操作。</p>
  </aside>
</template>
