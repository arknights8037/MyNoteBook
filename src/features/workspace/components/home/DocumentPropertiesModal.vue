<script setup lang="ts">
import { NButton, NInput, NModal } from '@/ui'
import type { DocumentSummary } from '@/models/documents/document'

defineProps<{
  document: DocumentSummary | null
  saving: boolean
  displayTitle: (document: DocumentSummary) => string
  parentTitle: (document: DocumentSummary) => string
  groupArticleCount: (documentId: string) => number
  characterCount: (document: DocumentSummary) => number
  formatDateTime: (timestamp: number) => string
}>()

const show = defineModel<boolean>('show', { required: true })
const tags = defineModel<string>('tags', { required: true })
const sourceUrl = defineModel<string>('sourceUrl', { required: true })
const author = defineModel<string>('author', { required: true })
const description = defineModel<string>('description', { required: true })

const emit = defineEmits<{
  save: []
  reset: []
}>()
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="document ? `${displayTitle(document)} · 属性` : '属性'"
    class="document-properties-modal"
    :bordered="false"
    @after-leave="emit('reset')"
  >
    <dl v-if="document" class="document-properties">
      <div class="document-properties__row">
        <dt>类型</dt><dd>{{ document.documentKind === 'group' ? '分组' : '页面' }}</dd>
      </div>
      <div v-if="document.documentKind === 'article'" class="document-properties__row">
        <dt>上级位置</dt><dd>{{ parentTitle(document) }}</dd>
      </div>
      <div v-else class="document-properties__row">
        <dt>页面数量</dt><dd>{{ groupArticleCount(document.id) }} 个</dd>
      </div>
      <div v-if="document.documentKind === 'article'" class="document-properties__row">
        <dt>字符数</dt><dd>{{ characterCount(document) }}</dd>
      </div>
      <div class="document-properties__row document-properties__row--field">
        <dt>标签</dt><dd><NInput v-model:value="tags" placeholder="用逗号、顿号或换行分隔标签" aria-label="标签" /></dd>
      </div>
      <div class="document-properties__row document-properties__row--field">
        <dt>来源 URL</dt><dd><NInput v-model:value="sourceUrl" placeholder="https://..." aria-label="来源 URL" /></dd>
      </div>
      <div class="document-properties__row document-properties__row--field">
        <dt>作者</dt><dd><NInput v-model:value="author" placeholder="作者或机构" aria-label="作者" /></dd>
      </div>
      <div class="document-properties__row document-properties__row--field">
        <dt>说明</dt>
        <dd><textarea v-model="description" class="document-properties__textarea" rows="3" placeholder="补充来源、用途、摘要或归档备注" aria-label="说明"></textarea></dd>
      </div>
      <div class="document-properties__row"><dt>创建时间</dt><dd>{{ formatDateTime(document.createdAt) }}</dd></div>
      <div class="document-properties__row"><dt>最后修改</dt><dd>{{ formatDateTime(document.updatedAt) }}</dd></div>
    </dl>
    <template #footer>
      <NButton @click="show = false">取消</NButton>
      <NButton type="primary" :loading="saving" @click="emit('save')">保存属性</NButton>
    </template>
  </NModal>
</template>
