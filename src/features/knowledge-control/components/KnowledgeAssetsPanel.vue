<script setup lang="ts">
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  FileText,
  Files,
  FileUp,
  MessageSquare,
  MessagesSquare,
  Search,
  SearchCheck,
  Trash2,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import type { AiChatHistoryItem } from '@/models/ai/aiChatHistory'
import type { KnowledgeAsset } from '@/models/knowledge/knowledgeAsset'
import { NButton, NIcon, NSelect } from '@/ui'

type BrowserFile = InstanceType<typeof globalThis.File>
type BrowserEvent = InstanceType<typeof globalThis.Event>
type BrowserInputElement = InstanceType<typeof globalThis.HTMLInputElement>

const props = defineProps<{
  assets: KnowledgeAsset[]
  conversations: AiChatHistoryItem[]
  loading: boolean
  importNotice: string
}>()
const emit = defineEmits<{
  importFile: [file: BrowserFile]
  importChat: [conversationId: string]
  importChatFile: [file: BrowserFile]
  view: [asset: KnowledgeAsset]
  openOriginal: [assetId: string]
  delete: [asset: KnowledgeAsset]
  research: [assets: KnowledgeAsset[]]
}>()

const fileInput = ref<BrowserInputElement | null>(null)
const chatFileInput = ref<BrowserInputElement | null>(null)
const conversationId = ref('')
const assetQuery = ref('')
const sourceFilter = ref('all')
const assetSection = ref<'files' | 'chats'>('files')
const initializedSection = ref(false)
const collapsedGroupIds = ref(new Set<string>())
const selectedAssetIds = ref(new Set<string>())
const sourceFilterOptions = [
  { label: '全部类型', value: 'all' },
  { label: '办公文件', value: 'office_file' },
  { label: '文本文件', value: 'text_file' },
]
const fileAssets = computed(() => props.assets.filter((asset) => asset.sourceType !== 'ai_chat'))
const chatAssets = computed(() => props.assets.filter((asset) => asset.sourceType === 'ai_chat'))
const importedConversationIds = computed(
  () => new Set(props.assets.map((asset) => asset.conversationId).filter(Boolean)),
)
const conversationOptions = computed(() =>
  props.conversations
    .filter((conversation) => !importedConversationIds.value.has(conversation.id))
    .map((conversation) => ({
      label: `${conversation.title} · ${conversation.messageCount} 条`,
      value: conversation.id,
    })),
)
const filteredAssets = computed(() => {
  const query = assetQuery.value.trim().toLocaleLowerCase()
  const sectionAssets = assetSection.value === 'files' ? fileAssets.value : chatAssets.value
  return sectionAssets.filter((asset) => {
    if (
      assetSection.value === 'files' &&
      sourceFilter.value !== 'all' &&
      asset.sourceType !== sourceFilter.value
    )
      return false
    if (!query) return true
    return [
      asset.title,
      asset.originalName,
      asset.provider,
      asset.model,
      asset.format,
      asset.importBatchName,
      asset.archivePath,
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query)
  })
})
const selectedAssets = computed(() =>
  props.assets.filter((asset) => selectedAssetIds.value.has(asset.id)),
)

interface AssetGroup {
  id: string
  title: string
  importedFromArchive: boolean
  assets: KnowledgeAsset[]
}

const groupedAssets = computed<AssetGroup[]>(() => {
  const groups = new Map<string, AssetGroup>()
  for (const asset of filteredAssets.value) {
    const isArchive = asset.importedFromArchive && Boolean(asset.importBatchId)
    const id = isArchive ? asset.importBatchId : `asset:${asset.id}`
    const existing = groups.get(id)
    if (existing) {
      existing.assets.push(asset)
      continue
    }
    groups.set(id, {
      id,
      title: isArchive ? asset.importBatchName || '压缩包导入' : asset.title,
      importedFromArchive: isArchive,
      assets: [asset],
    })
  }
  return [...groups.values()]
})

watch(
  () => props.assets,
  () => {
    if (initializedSection.value) return
    if (fileAssets.value.length === 0 && chatAssets.value.length > 0) assetSection.value = 'chats'
    initializedSection.value = true
  },
  { immediate: true },
)

function chooseFile(): void {
  fileInput.value?.click()
}

function handleFile(event: BrowserEvent): void {
  const input = event.target as BrowserInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('importFile', file)
}

function chooseChatFile(): void {
  chatFileInput.value?.click()
}

function handleChatFile(event: BrowserEvent): void {
  const input = event.target as BrowserInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('importChatFile', file)
}

function importConversation(): void {
  if (!conversationId.value) return
  emit('importChat', conversationId.value)
  conversationId.value = ''
}

function formatSize(bytes: number): string {
  if (!bytes) return '虚拟资产'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sourceLabel(asset: KnowledgeAsset): string {
  if (asset.sourceType === 'ai_chat') return 'AI 对话'
  return asset.sourceType === 'office_file' ? '办公文件' : '文本文件'
}

function setAssetSection(section: 'files' | 'chats'): void {
  assetSection.value = section
  assetQuery.value = ''
}

function toggleGroup(groupId: string): void {
  const next = new Set(collapsedGroupIds.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  collapsedGroupIds.value = next
}

function toggleAssetSelection(assetId: string): void {
  const next = new Set(selectedAssetIds.value)
  if (next.has(assetId)) next.delete(assetId)
  else next.add(assetId)
  selectedAssetIds.value = next
}

function researchSelectedAssets(): void {
  if (selectedAssets.value.length > 0) emit('research', selectedAssets.value)
}
</script>

<template>
  <section class="p1-domain-card knowledge-assets-panel">
    <header>
      <Database :size="18" />
      <div>
        <h2>知识资产</h2>
        <p>保留原始文件与提取文本，供后台自动总结、索引和知识处理。</p>
      </div>
    </header>

    <div class="knowledge-assets-sections" role="tablist" aria-label="知识资产类型">
      <button
        type="button"
        role="tab"
        :aria-selected="assetSection === 'files'"
        :class="{ 'is-active': assetSection === 'files' }"
        @click="setAssetSection('files')"
      >
        <Files :size="16" />
        <span>上传文件</span>
        <small>{{ fileAssets.length }}</small>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="assetSection === 'chats'"
        :class="{ 'is-active': assetSection === 'chats' }"
        @click="setAssetSection('chats')"
      >
        <MessagesSquare :size="16" />
        <span>AI 对话记录</span>
        <small>{{ chatAssets.length }}</small>
      </button>
    </div>

    <div class="knowledge-assets-panel__imports">
      <div v-if="assetSection === 'files'">
        <strong><FileText :size="15" />文档资产</strong>
        <span>PDF、Word (.docx)、Excel (.xlsx/.xls)、PowerPoint (.pptx) 及文本格式</span>
        <NButton type="primary" :loading="loading" @click="chooseFile">
          <template #icon
            ><NIcon :size="15"><FileUp /></NIcon
          ></template>
          导入文件
        </NButton>
        <input
          ref="fileInput"
          class="file-input-hidden"
          type="file"
          accept=".pdf,.docx,.xlsx,.xls,.pptx,.md,.markdown,.txt,.csv,.json"
          @change="handleFile"
        />
      </div>
      <div v-else>
        <strong><MessageSquare :size="15" />AI 对话记录</strong>
        <span>预览并选择导入完整问答、JSON 或 ZIP 包内记录</span>
        <div class="knowledge-assets-panel__chat-import">
          <NSelect
            v-model:value="conversationId"
            :options="conversationOptions"
            placeholder="选择尚未导入的对话"
            aria-label="AI 对话记录"
          />
          <NButton
            type="primary"
            :disabled="!conversationId"
            :loading="loading"
            @click="importConversation"
            >导入对话</NButton
          >
          <NButton secondary :loading="loading" @click="chooseChatFile">对话文件 / ZIP</NButton>
        </div>
        <input
          ref="chatFileInput"
          class="file-input-hidden"
          type="file"
          accept=".md,.markdown,.json,.txt,.zip"
          @change="handleChatFile"
        />
      </div>
    </div>

    <p v-if="importNotice" class="knowledge-assets-panel__notice" role="status">
      {{ importNotice }}
    </p>

    <div
      class="knowledge-assets-toolbar"
      :class="{ 'knowledge-assets-toolbar--chat': assetSection === 'chats' }"
    >
      <label class="knowledge-assets-search">
        <Search :size="15" />
        <input
          v-model="assetQuery"
          type="search"
          placeholder="搜索资产"
          aria-label="搜索知识资产"
        />
      </label>
      <NSelect
        v-if="assetSection === 'files'"
        v-model:value="sourceFilter"
        :options="sourceFilterOptions"
        aria-label="筛选资产类型"
      />
      <NButton
        v-if="selectedAssets.length"
        size="small"
        type="primary"
        @click="researchSelectedAssets"
      >
        <template #icon
          ><NIcon :size="14"><SearchCheck /></NIcon
        ></template>
        Research {{ selectedAssets.length }} 个文件
      </NButton>
      <span
        >{{ filteredAssets.length }} /
        {{ assetSection === 'files' ? fileAssets.length : chatAssets.length }}</span
      >
    </div>

    <div class="knowledge-assets-list">
      <section
        v-for="group in groupedAssets"
        :key="group.id"
        class="knowledge-assets-group"
        :class="{ 'knowledge-assets-group--archive': group.importedFromArchive }"
      >
        <button
          v-if="group.importedFromArchive"
          type="button"
          class="knowledge-assets-group__header"
          :aria-expanded="!collapsedGroupIds.has(group.id)"
          @click="toggleGroup(group.id)"
        >
          <Archive :size="16" />
          <span :title="group.title">{{ group.title }}</span>
          <small>{{ group.assets.length }} 项</small>
          <ChevronRight v-if="collapsedGroupIds.has(group.id)" :size="16" />
          <ChevronDown v-else :size="16" />
        </button>
        <div v-show="!collapsedGroupIds.has(group.id)" class="knowledge-assets-group__items">
          <article v-for="asset in group.assets" :key="asset.id">
            <input
              type="checkbox"
              class="knowledge-assets-list__checkbox"
              :checked="selectedAssetIds.has(asset.id)"
              :aria-label="`选择 ${asset.title}`"
              @change="toggleAssetSelection(asset.id)"
            />
            <span class="knowledge-assets-list__icon"
              ><MessageSquare v-if="asset.sourceType === 'ai_chat'" :size="17" /><FileText
                v-else
                :size="17"
            /></span>
            <div>
              <strong :title="asset.title">{{ asset.title }}</strong>
              <small
                >{{ sourceLabel(asset) }} · {{ asset.format }} · {{ formatSize(asset.sizeBytes) }} ·
                {{ asset.characterCount.toLocaleString() }} 字符<template v-if="asset.messageCount">
                  · {{ asset.messageCount }} 条消息</template
                >
                ·
                {{
                  asset.processingStatus === 'pending' ? '等待后台处理' : asset.processingStatus
                }}</small
              >
              <span
                >{{ asset.archivePath || asset.originalName
                }}<template v-if="asset.provider">
                  · {{ asset.provider }} / {{ asset.model || '未记录模型' }}</template
                ></span
              >
            </div>
            <div class="knowledge-assets-list__actions">
              <NButton size="small" secondary @click="emit('research', [asset])">
                <template #icon
                  ><NIcon :size="14"><SearchCheck /></NIcon
                ></template>
                Research
              </NButton>
              <NButton size="small" secondary @click="emit('view', asset)">查看</NButton>
              <NButton
                v-if="asset.assetId"
                size="small"
                quaternary
                @click="emit('openOriginal', asset.assetId)"
              >
                <template #icon
                  ><NIcon :size="14"><ExternalLink /></NIcon
                ></template>
                原文件
              </NButton>
              <NButton
                size="small"
                quaternary
                circle
                danger
                :aria-label="`删除 ${asset.title}`"
                @click="emit('delete', asset)"
              >
                <template #icon
                  ><NIcon :size="14"><Trash2 /></NIcon
                ></template>
              </NButton>
            </div>
          </article>
        </div>
      </section>
      <p v-if="assets.length === 0" class="operations-empty">
        还没有知识资产。导入文档或 AI 对话后，它们会出现在这里。
      </p>
      <p v-else-if="filteredAssets.length === 0" class="operations-empty">
        {{ assetSection === 'files' ? '没有匹配的上传文件。' : '没有匹配的 AI 对话记录。' }}
      </p>
    </div>
  </section>
</template>
