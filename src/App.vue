<script setup lang="ts">
import HomePage from '@/pages/HomePage.vue'
import { UiProvider } from '@/ui'
</script>

<template>
  <UiProvider>
    <HomePage />
  </UiProvider>
</template>
