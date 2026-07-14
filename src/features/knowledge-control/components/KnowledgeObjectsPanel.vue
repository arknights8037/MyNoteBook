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
    <header><ShieldCheck :size="18" /><div><h2>知识规则</h2><p>把当前文档中的规则、决定或证据登记为可追溯知识，不复制正文。</p></div></header>
    <form class="p1-inline-form" @submit.prevent="emit('create')">
      <select :value="objectType" aria-label="知识对象类型" @change="emit('update:objectType', ($event.target as HTMLSelectElement).value as KnowledgeObjectType)">
        <option value="rule">规则</option><option value="decision">决定</option>
        <option value="evidence">证据</option><option value="goal">目标</option><option value="task">任务</option>
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
      <p v-if="objects.length === 0" class="operations-empty">还没有知识规则。填写标题后可将它锚定到当前文档。</p>
    </div>
  </section>
</template>
