<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps<{ source: string }>()
const preview = ref<globalThis.HTMLDivElement | null>(null)
const error = ref('')
const renderId = `workspace-mermaid-${Math.random().toString(36).slice(2)}`
let request = 0
let timer: ReturnType<typeof globalThis.setTimeout> | null = null
watch(() => props.source, () => { if (timer) globalThis.clearTimeout(timer); timer = globalThis.setTimeout(() => void render(), 180) }, { immediate: true })
onBeforeUnmount(() => { if (timer) globalThis.clearTimeout(timer) })
async function render() {
  const current = ++request
  error.value = ''
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: globalThis.document.documentElement.dataset.themeMode === 'dark' ? 'dark' : 'default' })
    const result = await mermaid.render(`${renderId}-${current}`, props.source)
    if (current !== request) return
    await nextTick()
    if (preview.value) preview.value.innerHTML = result.svg
  } catch (renderError) { if (current === request) { error.value = renderError instanceof Error ? renderError.message : String(renderError); if (preview.value) preview.value.innerHTML = '' } }
}
</script>
<template><div class="workspace-mermaid-preview"><p v-if="error" role="alert">{{ error }}</p><div ref="preview" /></div></template>
