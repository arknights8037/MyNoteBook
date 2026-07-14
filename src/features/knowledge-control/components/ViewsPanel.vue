<script setup lang="ts">
import { BookOpenCheck } from '@lucide/vue'
import type { ViewDefinition, ViewType, ViewWritebackPolicy } from '@/models/view'
import { NButton } from '@/ui'

defineProps<{
  views: ViewDefinition[]; viewType: ViewType; name: string; query: string; prompt: string
  writebackPolicy: ViewWritebackPolicy; renders: Record<string, string>; loading: boolean
}>()
const emit = defineEmits<{
  'update:viewType': [value: ViewType]; 'update:name': [value: string]; 'update:query': [value: string]
  'update:prompt': [value: string]; 'update:writebackPolicy': [value: ViewWritebackPolicy]
  create: []; refresh: [view: ViewDefinition]; override: [view: ViewDefinition]
  propose: [view: ViewDefinition]; fork: [view: ViewDefinition]
}>()
</script>

<template>
  <section class="p1-domain-card">
    <header><BookOpenCheck :size="18" /><div><h2>Query / Projection / Generated Views</h2><p>手动刷新；Generated View 保留 provenance 并保护用户 override。</p></div></header>
    <form class="p1-view-form" @submit.prevent="emit('create')">
      <input :value="name" placeholder="视图名称" maxlength="160" @input="emit('update:name', ($event.target as HTMLInputElement).value)" />
      <select :value="viewType" aria-label="视图类型" @change="emit('update:viewType', ($event.target as HTMLSelectElement).value as ViewType)">
        <option value="query">Query</option><option value="projection">Projection</option><option value="generated">Generated</option>
      </select>
      <input v-if="viewType === 'query'" :value="query" placeholder="FTS5 查询" @input="emit('update:query', ($event.target as HTMLInputElement).value)" />
      <input v-if="viewType === 'generated'" :value="prompt" placeholder="生成指令（使用当前 AI Provider/Model）" @input="emit('update:prompt', ($event.target as HTMLInputElement).value)" />
      <select :value="writebackPolicy" aria-label="回写策略" @change="emit('update:writebackPolicy', ($event.target as HTMLSelectElement).value as ViewWritebackPolicy)">
        <option value="readonly">Readonly</option><option value="propose_changeset">Propose ChangeSet</option><option value="fork_document">Fork Document</option>
      </select>
      <NButton type="primary" :disabled="!name.trim()" :loading="loading" @click="emit('create')">创建 View</NButton>
    </form>
    <div class="p1-record-list">
      <article v-for="view in views" :key="view.id">
        <strong>{{ view.name }}</strong>
        <span>{{ view.viewType }} · {{ view.writebackPolicy }} · {{ view.stale ? 'stale' : 'fresh' }}</span>
        <NButton size="small" secondary :loading="loading" @click="emit('refresh', view)">手动刷新</NButton>
        <NButton v-if="view.viewType === 'generated' && !view.manualOverride" size="small" secondary :loading="loading" @click="emit('override', view)">保护为手动覆盖</NButton>
        <NButton v-if="view.writebackPolicy === 'propose_changeset'" size="small" secondary :loading="loading" @click="emit('propose', view)">生成 ChangeSet</NButton>
        <NButton v-if="view.writebackPolicy === 'fork_document'" size="small" secondary :loading="loading" @click="emit('fork', view)">分叉为独立文档</NButton>
        <pre v-if="renders[view.id]">{{ renders[view.id] }}</pre>
      </article>
      <p v-if="views.length === 0" class="operations-empty">尚无 View Definition</p>
    </div>
  </section>
</template>
