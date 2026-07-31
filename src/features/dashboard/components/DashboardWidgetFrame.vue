<script setup lang="ts">
import { Copy, GripHorizontal, RefreshCw, Trash2 } from '@lucide/vue'

withDefaults(
  defineProps<{
    title: string
    source: string
    editing: boolean
    refreshing?: boolean
    refreshable?: boolean
    systemState?: 'idle' | 'saving' | 'saved' | 'error'
  }>(),
  { refreshing: false, refreshable: true, systemState: 'idle' },
)

const emit = defineEmits<{
  copy: []
  remove: []
  refresh: []
}>()
</script>

<template>
  <article
    class="dashboard-widget-frame"
    :class="{
      'is-system-working': refreshing || systemState === 'saving',
      'is-system-saved': systemState === 'saved',
      'is-system-error': systemState === 'error',
    }"
    :aria-busy="refreshing || systemState === 'saving'"
  >
    <header class="dashboard-widget-frame__header">
      <div class="dashboard-widget-frame__heading">
        <GripHorizontal v-if="editing" class="dashboard-widget-frame__drag-handle" :size="16" />
        <div>
          <h3>{{ title }}</h3>
          <small>{{ source }}</small>
        </div>
      </div>
      <div v-if="$slots.summary" class="dashboard-widget-frame__summary">
        <slot name="summary" />
      </div>
      <div class="dashboard-widget-frame__actions">
        <slot name="actions" />
        <button
          v-if="refreshable !== false"
          type="button"
          :aria-label="refreshing ? '正在从系统刷新组件' : '刷新组件'"
          :title="refreshing ? '正在从系统读取' : '从系统重新读取'"
          :disabled="refreshing"
          @click="emit('refresh')"
        >
          <RefreshCw :class="{ 'is-spinning': refreshing }" :size="15" />
        </button>
        <template v-if="editing">
          <button type="button" aria-label="复制组件" @click="emit('copy')">
            <Copy :size="15" />
          </button>
          <button type="button" aria-label="移除组件" @click="emit('remove')">
            <Trash2 :size="15" />
          </button>
        </template>
      </div>
    </header>
    <div class="dashboard-widget-frame__body">
      <slot />
    </div>
  </article>
</template>
