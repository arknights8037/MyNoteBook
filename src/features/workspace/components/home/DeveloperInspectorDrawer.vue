<script setup lang="ts">
import { NDrawer, NDrawerContent } from '@/ui'

defineProps<{
  errorMessage: string
  saveStatus: string
  revision: string
  plainText: string
  previewJson: string
}>()

const show = defineModel<boolean>('show', { required: true })
</script>

<template>
  <NDrawer v-model:show="show" :width="380" placement="right">
    <NDrawerContent class="editor-inspector-content" title="开发面板" closable>
      <section v-if="errorMessage">
        <h2>Error</h2>
        <p>{{ errorMessage }}</p>
      </section>
      <section>
        <h2>Autosave</h2>
        <p>状态：{{ saveStatus }}</p>
        <p>Revision：{{ revision }}</p>
      </section>
      <section>
        <h2>Text</h2>
        <p>{{ plainText || '空文档' }}</p>
      </section>
      <section>
        <h2>JSON</h2>
        <pre>{{ previewJson }}</pre>
      </section>
    </NDrawerContent>
  </NDrawer>
</template>
