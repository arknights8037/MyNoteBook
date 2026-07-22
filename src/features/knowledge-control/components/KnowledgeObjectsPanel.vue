<script setup lang="ts">
import { BookOpenCheck, Filter, Search, ShieldCheck } from '@lucide/vue'
import { computed, ref } from 'vue'

import type { KnowledgeObject, KnowledgeObjectStatus, KnowledgeObjectType } from '@/models/knowledge/knowledge'
import { NButton, NSelect } from '@/ui'

const props = defineProps<{
  objects: KnowledgeObject[]
  objectType: KnowledgeObjectType
  title: string
  loading: boolean
}>()
const emit = defineEmits<{
  'update:objectType': [value: KnowledgeObjectType]
  'update:title': [value: string]
  create: []
  view: [object: KnowledgeObject]
}>()

const query = ref('')
const typeFilter = ref('all')
const statusFilter = ref('all')
const sourceFilter = ref('all')
const objectTypeOptions: Array<{ label: string; value: KnowledgeObjectType }> = [
  { label: '规则', value: 'rule' },
  { label: '决定', value: 'decision' },
  { label: '证据', value: 'evidence' },
  { label: '目标', value: 'goal' },
  { label: '任务', value: 'task' },
]
const typeFilterOptions = computed(() => [
  { label: '全部类型', value: 'all' },
  ...Array.from(new Set(props.objects.map((object) => object.objectType))).map((value) => ({
    label: objectTypeLabel(value),
    value,
  })),
])
const statusFilterOptions = [
  { label: '全部状态', value: 'all' },
  { label: 'Agent 强约束', value: 'effective' },
  { label: '已确认参考', value: 'approved' },
  { label: '等待处理', value: 'candidate' },
  { label: '草稿', value: 'draft' },
  { label: '已拒绝 / 停用', value: 'inactive' },
]
const sourceFilterOptions = [
  { label: '全部来源', value: 'all' },
  { label: 'Research', value: 'research' },
  { label: '手动创建', value: 'manual' },
]
const filteredObjects = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  return props.objects.filter((object) => {
    if (typeFilter.value !== 'all' && object.objectType !== typeFilter.value) return false
    if (!matchesStatus(object, statusFilter.value)) return false
    if (
      sourceFilter.value !== 'all' &&
      (sourceFilter.value === 'research') !== Boolean(object.cognitiveMode)
    )
      return false
    if (!normalizedQuery) return true
    return [
      object.title,
      object.content,
      object.objectType,
      object.status,
      userCategory(object),
      ...userTags(object),
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })
})

function updateObjectType(value: string): void {
  if (objectTypeOptions.some((option) => option.value === value)) {
    emit('update:objectType', value as KnowledgeObjectType)
  }
}

function matchesStatus(object: KnowledgeObject, filter: string): boolean {
  if (filter === 'all') return true
  if (filter === 'effective') return agentUseLevel(object) === 'constraint'
  if (filter === 'approved') return agentUseLevel(object) === 'reference'
  if (filter === 'inactive') return object.status === 'rejected' || object.status === 'deprecated'
  return object.status === filter
}

function agentUseLevel(object: KnowledgeObject): 'constraint' | 'reference' | 'unused' {
  if (
    (object.objectType === 'rule' || object.objectType === 'decision') &&
    (object.status === 'active' || object.status === 'approved')
  )
    return 'constraint'
  if (object.status === 'approved' || object.status === 'active') return 'reference'
  return 'unused'
}

function agentUseLabel(object: KnowledgeObject): string {
  const level = agentUseLevel(object)
  return level === 'constraint'
    ? 'Agent 强约束'
    : level === 'reference'
      ? 'Agent 参考知识'
      : '暂不进入 Agent 上下文'
}

function objectTypeLabel(type: KnowledgeObjectType): string {
  return (
    {
      rule: '规则',
      decision: '决定',
      evidence: '证据',
      goal: '目标',
      task: '任务',
      claim: '主张',
      inference: '推断',
      assumption: '假设',
      concept: '概念',
      question: '问题',
      limitation: '局限',
      fact: '事实',
      change_set: '变更集',
    } as Record<KnowledgeObjectType, string>
  )[type]
}

function statusLabel(status: KnowledgeObjectStatus): string {
  return (
    {
      draft: '草稿',
      candidate: '等待确认',
      approved: '已确认',
      active: '生效中',
      deprecated: '已停用',
      rejected: '已拒绝',
    } as Record<KnowledgeObjectStatus, string>
  )[status]
}

function userCategory(object: KnowledgeObject): string {
  return typeof object.structuredData.userCategory === 'string'
    ? object.structuredData.userCategory
    : ''
}

function userTags(object: KnowledgeObject): string[] {
  return Array.isArray(object.structuredData.userTags)
    ? object.structuredData.userTags.filter((tag): tag is string => typeof tag === 'string')
    : []
}
</script>

<template>
  <section class="p1-domain-card knowledge-objects-panel">
    <header>
      <ShieldCheck :size="18" />
      <div>
        <h2>知识规则</h2>
        <p>统一管理 Agent 约束与已经确认的 Research 参考知识。</p>
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

    <div class="knowledge-objects-usage">
      <span><ShieldCheck :size="14" /><strong>强约束</strong> 生效中的规则与决定</span>
      <span><BookOpenCheck :size="14" /><strong>参考知识</strong> 已确认的 Research 条目</span>
    </div>

    <div class="knowledge-objects-toolbar">
      <label>
        <Search :size="15" />
        <input v-model="query" type="search" placeholder="搜索标题、正文、分类或标签" />
      </label>
      <Filter :size="14" />
      <NSelect v-model:value="typeFilter" :options="typeFilterOptions" aria-label="筛选类型" />
      <NSelect
        v-model:value="statusFilter"
        :options="statusFilterOptions"
        aria-label="筛选状态"
      />
      <NSelect
        v-model:value="sourceFilter"
        :options="sourceFilterOptions"
        aria-label="筛选来源"
      />
      <span>{{ filteredObjects.length }} / {{ objects.length }}</span>
    </div>

    <div class="p1-record-list knowledge-objects-list">
      <button
        v-for="object in filteredObjects"
        :key="object.id"
        type="button"
        @click="emit('view', object)"
      >
        <span>
          <em>{{ objectTypeLabel(object.objectType) }}</em>
          <em :class="`is-${object.status}`">{{ statusLabel(object.status) }}</em>
          <em :class="`is-use-${agentUseLevel(object)}`">{{ agentUseLabel(object) }}</em>
        </span>
        <strong>{{ object.title }}</strong>
        <p>{{ object.content || '该对象只保存了标题，尚无详细正文。' }}</p>
        <small>
          <template v-if="userCategory(object)">分类：{{ userCategory(object) }} · </template>
          <template v-if="userTags(object).length">{{ userTags(object).join(' / ') }} · </template>
          {{ object.cognitiveMode ? `${object.cognitiveMode} 生成` : '手动创建' }} · v{{ object.version }}
        </small>
      </button>
      <p v-if="objects.length === 0" class="operations-empty">还没有知识对象。</p>
      <p v-else-if="filteredObjects.length === 0" class="operations-empty">没有匹配的知识对象。</p>
    </div>
  </section>
</template>
