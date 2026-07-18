<script setup lang="ts">
import { BookOpenCheck, CheckCircle2, Link2, ShieldCheck } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import type { KnowledgeObject } from '@/models/knowledge'
import type { KnowledgeObjectDetail } from '@/services/KnowledgeControlService'
import { NButton, NModal } from '@/ui'

const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{ detail: KnowledgeObjectDetail | null; loading: boolean }>()
const emit = defineEmits<{
  save: [input: {
    id: string
    expectedVersion: number
    category: string
    tags: string[]
  }]
}>()

const category = ref('')
const tags = ref('')
const object = computed(() => props.detail?.object ?? null)

watch(
  () => props.detail,
  (detail) => {
    category.value = stringValue(detail?.object.structuredData.userCategory)
    tags.value = arrayValue(detail?.object.structuredData.userTags).join(', ')
  },
  { immediate: true },
)

function save(): void {
  if (!object.value) return
  emit('save', {
    id: object.value.id,
    expectedVersion: object.value.version,
    category: category.value,
    tags: tags.value.split(/[,，]/),
  })
}

function useLabel(value: KnowledgeObject): string {
  if (
    (value.objectType === 'rule' || value.objectType === 'decision') &&
    (value.status === 'active' || value.status === 'approved')
  )
    return 'Agent 强约束'
  if (value.status === 'approved' || value.status === 'active') return 'Agent 参考知识'
  return '暂不进入 Agent 上下文'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="object?.title ?? '知识详情'"
    class="knowledge-object-detail"
    :bordered="false"
  >
    <template v-if="object && detail">
      <div class="knowledge-object-detail__badges">
        <span><ShieldCheck :size="14" />{{ object.objectType }}</span>
        <span>{{ object.status }}</span>
        <span><BookOpenCheck :size="14" />{{ useLabel(object) }}</span>
        <span>v{{ object.version }}</span>
      </div>

      <div class="knowledge-object-detail__form">
        <label>标题<input :value="object.title" readonly /></label>
        <label>分类<input v-model="category" maxlength="80" placeholder="例如：Agent 架构" /></label>
        <label class="is-wide"
          >标签<input v-model="tags" maxlength="400" placeholder="使用逗号分隔"
        /></label>
        <label class="is-wide">正文<textarea :value="object.content" rows="9" readonly></textarea></label>
      </div>

      <section class="knowledge-object-detail__section">
        <h3><Link2 :size="15" />来源 {{ detail.sources.length }}</h3>
        <article v-for="source in detail.sources" :key="source.id">
          <strong>{{ source.documentId }}{{ source.blockId ? ` / ${source.blockId}` : '' }}</strong>
          <small>revision {{ source.revision }}</small>
          <p>{{ source.quote || '未保存引用片段' }}</p>
        </article>
        <p v-if="detail.sources.length === 0">没有稳定文档来源。</p>
      </section>

      <section class="knowledge-object-detail__section">
        <h3><CheckCircle2 :size="15" />验证 {{ detail.validations.length }}</h3>
        <article v-for="validation in detail.validations" :key="validation.id">
          <strong>{{ validation.verdict }} · {{ validation.ruleId }}</strong>
          <small>{{ validation.severity }}</small>
          <p>{{ validation.message }}</p>
        </article>
        <p v-if="detail.validations.length === 0">尚无验证记录。</p>
      </section>

      <dl class="knowledge-object-detail__provenance">
        <div><dt>生成模式</dt><dd>{{ object.cognitiveMode || '手动创建' }}</dd></div>
        <div><dt>运行 ID</dt><dd>{{ object.generatedRunId || '无' }}</dd></div>
        <div><dt>模板</dt><dd>{{ object.templateId || '无' }}</dd></div>
        <div><dt>关系</dt><dd>{{ detail.relations.length }}</dd></div>
      </dl>
    </template>
    <p v-else class="operations-empty">正在加载知识详情...</p>

    <template #footer>
      <NButton @click="show = false">关闭</NButton>
      <NButton type="primary" :loading="loading" @click="save"
        >保存分类与标签</NButton
      >
    </template>
  </NModal>
</template>
