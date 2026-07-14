<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

import UiProvider from '@/ui/UiProvider.vue'

const HomePage = defineAsyncComponent(() => import('@/pages/HomePage.vue'))
</script>

<template>
  <UiProvider>
    <Suspense>
      <HomePage />
      <template #fallback>
        <main class="startup-shell" aria-label="正在启动">
          <aside class="startup-shell__sidebar">
            <div class="startup-shell__brand">
              <span class="startup-shell__logo" aria-hidden="true"></span>
              <strong>myNoteBook</strong>
            </div>
            <div class="startup-shell__nav-lines" aria-hidden="true">
              <span></span><span></span><span></span><span></span>
            </div>
          </aside>
          <section class="startup-shell__content">
            <div class="startup-shell__toolbar" aria-hidden="true"></div>
            <div class="startup-shell__document" aria-hidden="true">
              <span class="startup-shell__title"></span>
              <span></span><span></span><span></span>
            </div>
            <div class="startup-shell__status" role="status" aria-live="polite">
              <span class="startup-shell__spinner" aria-hidden="true"><i></i><i></i><i></i></span>
              <span>
                <strong>正在打开知识库</strong>
                <small>准备本地文档与编辑器</small>
              </span>
            </div>
            <span class="startup-shell__progress" aria-hidden="true"><i></i></span>
          </section>
        </main>
      </template>
    </Suspense>
  </UiProvider>
</template>
