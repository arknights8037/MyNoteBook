<script setup lang="ts">
import { ExternalLink, FileText, MessageSquare, Trash2 } from '@lucide/vue'
import { computed } from 'vue'

import type { KnowledgeAsset } from '@/models/knowledge/knowledgeAsset'
import { renderAiMarkdown } from '@/services/ai/AiMarkdownRenderer'
import { NButton, NIcon, NModal } from '@/ui'

const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{ asset: KnowledgeAsset | null }>()
const emit = defineEmits<{
  openOriginal: [assetId: string]
  delete: [asset: KnowledgeAsset]
}>()

const rendersMarkdown = computed(() => {
  const asset = props.asset
  if (!asset) return false
  return (
    asset.sourceType === 'ai_chat' ||
    /(?:MARKDOWN|\bMD\b)/i.test(asset.format) ||
    /\.md$/i.test(asset.originalName)
  )
})
const renderedContent = computed(() => renderAiMarkdown(props.asset?.content ?? ''))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="asset?.title ?? '知识资产'"
    class="knowledge-asset-preview"
    :bordered="false"
  >
    <template v-if="asset">
      <div class="knowledge-asset-preview__meta">
        <span
          ><MessageSquare v-if="asset.sourceType === 'ai_chat'" :size="15" /><FileText
            v-else
            :size="15"
          />{{ asset.sourceType === 'ai_chat' ? 'AI 对话' : '文档资产' }}</span
        >
        <span>{{ asset.format }}</span>
        <span>{{ formatSize(asset.sizeBytes) }}</span>
        <span>{{ asset.characterCount.toLocaleString() }} 字符</span>
        <span v-if="asset.messageCount">{{ asset.messageCount }} 条消息</span>
        <span>{{
          asset.processingStatus === 'pending' ? '等待后台处理' : asset.processingStatus
        }}</span>
      </div>
      <dl class="knowledge-asset-preview__details">
        <div>
          <dt>原始文件</dt>
          <dd>{{ asset.originalName }}</dd>
        </div>
        <div v-if="asset.provider">
          <dt>模型来源</dt>
          <dd>{{ asset.provider }} / {{ asset.model || '未记录模型' }}</dd>
        </div>
      </dl>
      <!-- renderAiMarkdown emits only allowlisted tags and escapes text, attributes and URLs. -->
      <!-- eslint-disable vue/no-v-html -->
      <div
        v-if="rendersMarkdown"
        class="knowledge-asset-preview__content knowledge-asset-preview__content--markdown markdown-preview"
        v-html="renderedContent"
      ></div>
      <!-- eslint-enable vue/no-v-html -->
      <pre v-else class="knowledge-asset-preview__content">{{ asset.content }}</pre>
    </template>
    <template #footer>
      <NButton v-if="asset" quaternary danger @click="emit('delete', asset)">
        <template #icon
          ><NIcon :size="14"><Trash2 /></NIcon
        ></template>
        删除
      </NButton>
      <NButton @click="show = false">关闭</NButton>
      <NButton v-if="asset?.assetId" secondary @click="emit('openOriginal', asset.assetId)">
        <template #icon
          ><NIcon :size="14"><ExternalLink /></NIcon
        ></template>
        打开原文件
      </NButton>
    </template>
  </NModal>
</template>
