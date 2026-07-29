<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  title: string
  icon?: Component
  meta?: string
}>()
</script>

<template>
  <header class="surface-title-bar">
    <div class="surface-title-bar__identity">
      <slot name="leading" />
      <span v-if="icon" class="surface-title-bar__icon" aria-hidden="true">
        <component :is="icon" :size="18" />
      </span>
      <div>
        <h1>{{ title }}</h1>
        <p v-if="meta">{{ meta }}</p>
      </div>
    </div>
    <div v-if="$slots.actions" class="surface-title-bar__actions">
      <slot name="actions" />
    </div>
  </header>
</template>
