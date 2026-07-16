<script setup lang="ts">
import { ShieldCheck } from '@lucide/vue'
import type { KnowledgeObject, KnowledgeObjectType } from '@/models/knowledge'
import { NButton, NSelect } from '@/ui'

defineProps<{
  objects: KnowledgeObject[]
  objectType: KnowledgeObjectType
  title: string
  loading: boolean
}>()
const emit = defineEmits<{
  'update:objectType': [value: KnowledgeObjectType]
  'update:title': [value: string]
  create: []
}>()

const objectTypeOptions: Array<{ label: string; value: KnowledgeObjectType }> = [
  { label: '规则', value: 'rule' },
  { label: '决定', value: 'decision' },
  { label: '证据', value: 'evidence' },
  { label: '目标', value: 'goal' },
  { label: '任务', value: 'task' },
]

function updateObjectType(value: string): void {
  if (objectTypeOptions.some((option) => option.value === value)) {
    emit('update:objectType', value as KnowledgeObjectType)
  }
}

function formatAnchor(object: KnowledgeObject): string {
  if (!object.documentId) return '未锚定文档'
  return `${object.documentId}${object.blockId ? ` / ${object.blockId}` : ''} @ r${object.sourceRevision ?? '?'}`
}
</script>

<template>
  <section class="p1-domain-card">
    <header>
      <ShieldCheck :size="18" />
      <div>
        <h2>知识规则</h2>
        <p>把当前文档中的规则、决定或证据登记为可追溯知识，不复制正文。</p>
      </div>
    </header>
    <form class="p1-inline-form" @submit.prevent="emit('create')">
      <NSelect
        :value="objectType"
        :options="objectTypeOptions"
        aria-label="知识对象类型"
        @update:value="updateObjectType"
      />
      <input
        :value="title"
        placeholder="标题或规范摘要"
        maxlength="240"
        @input="emit('update:title', ($event.target as HTMLInputElement).value)"
      />
      <NButton type="primary" :disabled="!title.trim()" :loading="loading" @click="emit('create')"
        >创建并锚定当前文档</NButton
      >
    </form>
    <div class="p1-record-list">
      <article v-for="object in objects" :key="object.id">
        <strong>{{ object.title }}</strong>
        <span>{{ object.objectType }} · {{ object.status }} · v{{ object.version }}</span>
        <small>{{ formatAnchor(object) }}</small>
      </article>
      <p v-if="objects.length === 0" class="operations-empty">
        还没有知识规则。填写标题后可将它锚定到当前文档。
      </p>
    </div>
  </section>
</template>
