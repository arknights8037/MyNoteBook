<script setup lang="ts">
import { Archive, FileJson, FileText, MessageSquare } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import type {
  AiConversationImportMode,
  AiConversationImportSelection,
  ImportedAiConversationFile,
} from '@/services/KnowledgeAssetImporter'
import { renderAiMarkdown } from '@/services/AiMarkdownRenderer'
import { NButton, NIcon, NModal } from '@/ui'

const props = defineProps<{
  candidates: ImportedAiConversationFile[]
  failures: string[]
  archiveName: string
  loading: boolean
}>()
const show = defineModel<boolean>('show', { required: true })
const emit = defineEmits<{ confirm: [selections: AiConversationImportSelection[]] }>()

const selectedIds = ref<Set<string>>(new Set())
const modes = ref<Record<string, AiConversationImportMode>>({})
const activeId = ref('')

watch(
  () => props.candidates,
  (candidates) => {
    selectedIds.value = new Set(candidates.map(candidateId))
    modes.value = Object.fromEntries(
      candidates.map((candidate) => [candidateId(candidate), candidate.defaultMode]),
    )
    activeId.value = candidates[0] ? candidateId(candidates[0]) : ''
  },
  { immediate: true },
)

const selectedCount = computed(() => selectedIds.value.size)
const allSelected = computed(
  () => props.candidates.length > 0 && selectedCount.value === props.candidates.length,
)
const activeCandidate = computed(
  () => props.candidates.find((candidate) => candidateId(candidate) === activeId.value) ?? null,
)
const activeMode = computed(() =>
  activeCandidate.value ? modes.value[candidateId(activeCandidate.value)] : undefined,
)
const previewMarkdown = computed(() => {
  const candidate = activeCandidate.value
  if (!candidate) return ''
  return activeMode.value === 'markdown'
    ? candidate.markdownText
    : (candidate.conversationText ?? candidate.text)
})
const renderedPreview = computed(() => renderAiMarkdown(previewMarkdown.value))

function candidateId(candidate: ImportedAiConversationFile): string {
  return candidate.originalPath
}

function toggleCandidate(candidate: ImportedAiConversationFile, checked: boolean): void {
  const next = new Set(selectedIds.value)
  if (checked) next.add(candidateId(candidate))
  else next.delete(candidateId(candidate))
  selectedIds.value = next
}

function toggleAll(): void {
  selectedIds.value = allSelected.value ? new Set() : new Set(props.candidates.map(candidateId))
}

function setMode(candidate: ImportedAiConversationFile, mode: AiConversationImportMode): void {
  if (!candidate.availableModes.includes(mode)) return
  modes.value = { ...modes.value, [candidateId(candidate)]: mode }
  activeId.value = candidateId(candidate)
}

function confirmImport(): void {
  const selections = props.candidates
    .filter((candidate) => selectedIds.value.has(candidateId(candidate)))
    .map((candidate) => ({
      candidate,
      mode: modes.value[candidateId(candidate)] ?? candidate.defaultMode,
    }))
  if (selections.length) emit('confirm', selections)
}

function isJson(candidate: ImportedAiConversationFile): boolean {
  return /\.json$/i.test(candidate.file.name)
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    title="选择要导入的内容"
    class="ai-import-preview"
    :bordered="false"
  >
    <div class="ai-import-preview__summary">
      <span><Archive :size="15" />{{ archiveName }}</span>
      <span>{{ candidates.length }} 个可导入文件</span>
      <span v-if="failures.length" class="is-warning">{{ failures.length }} 个解析失败</span>
    </div>

    <div class="ai-import-preview__layout">
      <section class="ai-import-preview__files" aria-label="可导入文件">
        <header>
          <label>
            <input type="checkbox" :checked="allSelected" @change="toggleAll" />
            <strong>全选</strong>
          </label>
          <span>已选 {{ selectedCount }}/{{ candidates.length }}</span>
        </header>
        <button
          v-for="candidate in candidates"
          :key="candidateId(candidate)"
          type="button"
          :class="{ 'is-active': candidateId(candidate) === activeId }"
          @click="activeId = candidateId(candidate)"
        >
          <input
            type="checkbox"
            :checked="selectedIds.has(candidateId(candidate))"
            :aria-label="`选择 ${candidate.title}`"
            @click.stop
            @change="toggleCandidate(candidate, ($event.target as HTMLInputElement).checked)"
          />
          <FileJson v-if="isJson(candidate)" :size="16" />
          <FileText v-else :size="16" />
          <span>
            <strong>{{ candidate.title }}</strong>
            <small>{{ candidate.originalPath }}</small>
          </span>
          <em v-if="candidate.messageCount">{{ candidate.messageCount }} 条</em>
        </button>
      </section>

      <section v-if="activeCandidate" class="ai-import-preview__preview">
        <header>
          <div>
            <strong>{{ activeCandidate.title }}</strong>
            <small>{{ activeCandidate.originalPath }}</small>
          </div>
          <div v-if="activeCandidate.availableModes.length > 1" class="ai-import-preview__modes">
            <button
              type="button"
              :class="{ 'is-active': activeMode === 'conversation' }"
              @click="setMode(activeCandidate, 'conversation')"
            >
              <MessageSquare :size="14" />对话记录
            </button>
            <button
              type="button"
              :class="{ 'is-active': activeMode === 'markdown' }"
              @click="setMode(activeCandidate, 'markdown')"
            >
              <FileText :size="14" />Markdown
            </button>
          </div>
          <span v-else class="ai-import-preview__mode-label">
            <FileText :size="14" />{{ activeMode === 'markdown' ? 'Markdown' : '对话记录' }}
          </span>
        </header>
        <!-- renderAiMarkdown emits only allowlisted tags and escapes text, attributes and URLs. -->
        <!-- eslint-disable vue/no-v-html -->
        <div class="ai-import-preview__markdown markdown-preview" v-html="renderedPreview"></div>
        <!-- eslint-enable vue/no-v-html -->
      </section>
    </div>

    <details v-if="failures.length" class="ai-import-preview__failures">
      <summary>查看解析失败的文件</summary>
      <ul>
        <li v-for="failure in failures" :key="failure">{{ failure }}</li>
      </ul>
    </details>

    <template #footer>
      <NButton @click="show = false">取消</NButton>
      <NButton
        type="primary"
        :loading="loading"
        :disabled="selectedCount === 0"
        @click="confirmImport"
      >
        <template #icon
          ><NIcon :size="14"><Archive /></NIcon
        ></template>
        导入所选 {{ selectedCount }} 项
      </NButton>
    </template>
  </NModal>
</template>
