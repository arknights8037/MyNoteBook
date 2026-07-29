<script setup lang="ts">
import { Copy, GripHorizontal, RefreshCw, Trash2 } from '@lucide/vue'

defineProps<{
  title: string
  source: string
  editing: boolean
  refreshing?: boolean
  refreshable?: boolean
}>()

const emit = defineEmits<{
  copy: []
  remove: []
  refresh: []
}>()
</script>

<template>
  <article class="dashboard-widget-frame">
    <header class="dashboard-widget-frame__header">
      <div class="dashboard-widget-frame__heading">
        <GripHorizontal v-if="editing" class="dashboard-widget-frame__drag-handle" :size="16" />
        <div>
          <h3>{{ title }}</h3>
          <small>{{ source }}</small>
        </div>
      </div>
      <div class="dashboard-widget-frame__actions">
        <button
          v-if="refreshable !== false"
          type="button"
          aria-label="刷新组件"
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
