<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string
  }>(),
  { label: '正在加载功能模块' },
)
</script>

<template>
  <div class="lazy-surface-loader" role="status" aria-live="polite">
    <span class="lazy-surface-loader__orbit" aria-hidden="true"> <i></i><i></i><i></i> </span>
    <span>{{ label }}</span>
  </div>
</template>
