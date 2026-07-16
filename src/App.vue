<script setup lang="ts">
import { defineAsyncComponent, h } from 'vue'

import UiProvider from '@/ui/UiProvider.vue'

const StartupShell = () =>
  h(
    'main',
    { class: 'startup-shell', 'aria-label': '正在启动' },
    h('div', { class: 'startup-shell__status', role: 'status', 'aria-live': 'polite' }, [
      h('span', { class: 'startup-shell__spinner', 'aria-hidden': 'true' }),
      h('span', [h('strong', '正在打开知识库'), h('small', '准备本地文档与编辑器')]),
    ]),
  )

const HomePage = defineAsyncComponent({
  loader: () => import('@/pages/HomePage.vue'),
  loadingComponent: StartupShell,
  delay: 0,
  suspensible: false,
})
</script>

<template>
  <UiProvider>
    <HomePage />
  </UiProvider>
</template>
