<script setup lang="ts">
import { BookOpenCheck } from '@lucide/vue'
import type { ViewDefinition, ViewType, ViewWritebackPolicy } from '@/models/view'
import { NButton, NSelect } from '@/ui'

defineProps<{
  views: ViewDefinition[]
  viewType: ViewType
  name: string
  query: string
  prompt: string
  writebackPolicy: ViewWritebackPolicy
  renders: Record<string, string>
  loading: boolean
}>()

const viewTypeOptions: Array<{ label: string; value: ViewType }> = [
  { label: '搜索结果', value: 'query' },
  { label: '字段整理', value: 'projection' },
  { label: 'AI 生成', value: 'generated' },
]
const writebackPolicyOptions: Array<{ label: string; value: ViewWritebackPolicy }> = [
  { label: '只读，不写回', value: 'readonly' },
  { label: '提出修改建议', value: 'propose_changeset' },
  { label: '生成独立文档', value: 'fork_document' },
]

function updateViewType(value: string): void {
  if (viewTypeOptions.some((option) => option.value === value)) {
    emit('update:viewType', value as ViewType)
  }
}

function updateWritebackPolicy(value: string): void {
  if (writebackPolicyOptions.some((option) => option.value === value)) {
    emit('update:writebackPolicy', value as ViewWritebackPolicy)
  }
}
const emit = defineEmits<{
  'update:viewType': [value: ViewType]
  'update:name': [value: string]
  'update:query': [value: string]
  'update:prompt': [value: string]
  'update:writebackPolicy': [value: ViewWritebackPolicy]
  create: []
  refresh: [view: ViewDefinition]
  override: [view: ViewDefinition]
  propose: [view: ViewDefinition]
  fork: [view: ViewDefinition]
}>()
</script>

<template>
  <section class="p1-domain-card">
    <header>
      <BookOpenCheck :size="18" />
      <div>
        <h2>智能视图</h2>
        <p>按条件查询、整理字段或生成摘要；只有手动刷新时才会更新。</p>
      </div>
    </header>
    <form class="p1-view-form" @submit.prevent="emit('create')">
      <input
        :value="name"
        placeholder="视图名称"
        maxlength="160"
        @input="emit('update:name', ($event.target as HTMLInputElement).value)"
      />
      <NSelect
        :value="viewType"
        :options="viewTypeOptions"
        aria-label="视图类型"
        @update:value="updateViewType"
      />
      <input
        v-if="viewType === 'query'"
        :value="query"
        placeholder="FTS5 查询"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
      <input
        v-if="viewType === 'generated'"
        :value="prompt"
        placeholder="生成指令（使用当前 AI Provider/Model）"
        @input="emit('update:prompt', ($event.target as HTMLInputElement).value)"
      />
      <NSelect
        :value="writebackPolicy"
        :options="writebackPolicyOptions"
        aria-label="回写策略"
        @update:value="updateWritebackPolicy"
      />
      <NButton type="primary" :disabled="!name.trim()" :loading="loading" @click="emit('create')"
        >创建 View</NButton
      >
    </form>
    <div class="p1-record-list">
      <article v-for="view in views" :key="view.id">
        <strong>{{ view.name }}</strong>
        <span
          >{{ view.viewType }} · {{ view.writebackPolicy }} ·
          {{ view.stale ? 'stale' : 'fresh' }}</span
        >
        <NButton size="small" secondary :loading="loading" @click="emit('refresh', view)"
          >手动刷新</NButton
        >
        <NButton
          v-if="view.viewType === 'generated' && !view.manualOverride"
          size="small"
          secondary
          :loading="loading"
          @click="emit('override', view)"
          >保护为手动覆盖</NButton
        >
        <NButton
          v-if="view.writebackPolicy === 'propose_changeset'"
          size="small"
          secondary
          :loading="loading"
          @click="emit('propose', view)"
          >生成 ChangeSet</NButton
        >
        <NButton
          v-if="view.writebackPolicy === 'fork_document'"
          size="small"
          secondary
          :loading="loading"
          @click="emit('fork', view)"
          >分叉为独立文档</NButton
        >
        <pre v-if="renders[view.id]">{{ renders[view.id] }}</pre>
      </article>
      <p v-if="views.length === 0" class="operations-empty">
        还没有智能视图。先选择一种整理方式并填写名称。
      </p>
    </div>
  </section>
</template>
