<script setup lang="ts">
import { ShieldCheck } from '@lucide/vue'
import type { KnowledgeObject, KnowledgeObjectType } from '@/models/knowledge'
import { NButton } from '@/ui'

defineProps<{ objects: KnowledgeObject[]; objectType: KnowledgeObjectType; title: string; loading: boolean }>()
const emit = defineEmits<{
  'update:objectType': [value: KnowledgeObjectType]
  'update:title': [value: string]
  create: []
}>()

function formatAnchor(object: KnowledgeObject): string {
  if (!object.documentId) return '未锚定文档'
  return `${object.documentId}${object.blockId ? ` / ${object.blockId}` : ''} @ r${object.sourceRevision ?? '?'}`
}
</script>

<template>
  <section class="p1-domain-card">
    <header><ShieldCheck :size="18" /><div><h2>Knowledge Objects</h2><p>Rule、Decision、Evidence 和 ChangeSet 元数据不复制正文。</p></div></header>
    <form class="p1-inline-form" @submit.prevent="emit('create')">
      <select :value="objectType" aria-label="知识对象类型" @change="emit('update:objectType', ($event.target as HTMLSelectElement).value as KnowledgeObjectType)">
        <option value="rule">Rule</option><option value="decision">Decision</option>
        <option value="evidence">Evidence</option><option value="goal">Goal</option><option value="task">Task</option>
      </select>
      <input :value="title" placeholder="标题或规范摘要" maxlength="240" @input="emit('update:title', ($event.target as HTMLInputElement).value)" />
      <NButton type="primary" :disabled="!title.trim()" :loading="loading" @click="emit('create')">创建并锚定当前文档</NButton>
    </form>
    <div class="p1-record-list">
      <article v-for="object in objects" :key="object.id">
        <strong>{{ object.title }}</strong>
        <span>{{ object.objectType }} · {{ object.status }} · v{{ object.version }}</span>
        <small>{{ formatAnchor(object) }}</small>
      </article>
      <p v-if="objects.length === 0" class="operations-empty">尚无结构化知识对象</p>
    </div>
  </section>
</template>
