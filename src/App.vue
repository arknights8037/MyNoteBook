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
          <section class="startup-shell__content" aria-hidden="true">
            <div class="startup-shell__toolbar"></div>
            <div class="startup-shell__document">
              <span class="startup-shell__title"></span>
              <span></span><span></span><span></span>
            </div>
          </section>
        </main>
      </template>
    </Suspense>
  </UiProvider>
</template>
