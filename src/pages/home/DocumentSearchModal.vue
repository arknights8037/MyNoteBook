<script setup lang="ts">
import { FileText, Folder, Search } from '@lucide/vue'

import { NIcon, NInput, NModal } from '@/ui'
import type { DocumentSummary } from '@/models/document'

defineProps<{
  results: DocumentSummary[]
  displayTitle: (document: DocumentSummary) => string
  getSnippet: (document: DocumentSummary) => string
}>()

const show = defineModel<boolean>('show', { required: true })
const query = defineModel<string>('query', { required: true })

const emit = defineEmits<{
  openFirst: []
  open: [document: DocumentSummary]
}>()
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    title="搜索笔记"
    class="search-modal"
    :bordered="false"
    @after-leave="query = ''"
  >
    <NInput
      v-model:value="query"
      autofocus
      clearable
      placeholder="搜索标题或正文"
      aria-label="搜索标题或正文"
      @keydown.enter.prevent="emit('openFirst')"
    >
      <template #prefix><NIcon :size="17"><Search /></NIcon></template>
    </NInput>

    <div v-if="query.trim()" class="search-results" role="listbox" aria-label="搜索结果">
      <button
        v-for="document in results"
        :key="document.id"
        type="button"
        class="search-results__item"
        @click="emit('open', document)"
      >
        <Folder v-if="document.documentKind === 'group'" :size="17" />
        <FileText v-else :size="17" />
        <span class="search-results__content">
          <span class="search-results__title">{{ displayTitle(document) }}</span>
          <span class="search-results__snippet">{{ getSnippet(document) }}</span>
        </span>
      </button>
      <p v-if="results.length === 0" class="search-results__empty">没有找到匹配的笔记</p>
    </div>
    <p v-else class="search-results__hint">输入关键词搜索标题和正文，按 Enter 打开首条结果。</p>
  </NModal>
</template>
