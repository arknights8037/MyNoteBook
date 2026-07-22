<script setup lang="ts">
import { BookOpenCheck, Database, ListChecks, RefreshCw, ShieldCheck } from '@lucide/vue'
import { onMounted, ref } from 'vue'

import { loadAiSettings } from '@/models/ai/ai'
import type { DelegationGrant } from '@/models/knowledge/governance'
import type { KnowledgeObject, KnowledgeObjectType } from '@/models/knowledge/knowledge'
import type { KnowledgeAsset } from '@/models/knowledge/knowledgeAsset'
import type { AiChatHistoryItem } from '@/models/ai/aiChatHistory'
import type { ViewDefinition, ViewType, ViewWritebackPolicy } from '@/models/knowledge/view'
import type { TaskRun } from '@/models/knowledge/work'
import type { KnowledgeControlService } from '@/services/knowledge/KnowledgeControlService'
import type { KnowledgeObjectDetail } from '@/services/knowledge/KnowledgeControlService'
import type {
  AiConversationImportBatch,
  AiConversationImportSelection,
} from '@/services/knowledge/KnowledgeAssetImporter'
import KnowledgeObjectsPanel from '@/features/knowledge-control/components/KnowledgeObjectsPanel.vue'
import KnowledgeObjectDetailModal from '@/features/knowledge-control/components/KnowledgeObjectDetailModal.vue'
import KnowledgeAssetsPanel from '@/features/knowledge-control/components/KnowledgeAssetsPanel.vue'
import KnowledgeAssetPreviewModal from '@/features/knowledge-control/components/KnowledgeAssetPreviewModal.vue'
import AiConversationImportPreviewModal from '@/features/knowledge-control/components/AiConversationImportPreviewModal.vue'
import TaskRunsPanel from '@/features/knowledge-control/components/TaskRunsPanel.vue'
import ViewsPanel from '@/features/knowledge-control/components/ViewsPanel.vue'
import { NButton, NIcon, useDialog, useMessage } from '@/ui'

type BrowserFile = InstanceType<typeof globalThis.File>

const props = withDefaults(
  defineProps<{
    currentDocumentId: string
    currentDocumentRevision: number
    getService: () => Promise<KnowledgeControlService>
    chatHistory?: AiChatHistoryItem[]
    contextNavigation?: boolean
  }>(),
  { chatHistory: () => [], contextNavigation: false },
)
const emit = defineEmits<{
  researchAssets: [assets: KnowledgeAsset[]]
}>()
const objects = ref<KnowledgeObject[]>([])
const assets = ref<KnowledgeAsset[]>([])
const assetImportNotice = ref('')
const selectedAsset = ref<KnowledgeAsset | null>(null)
const selectedObjectDetail = ref<KnowledgeObjectDetail | null>(null)
const showObjectDetail = ref(false)
const showAssetPreview = ref(false)
const showAiImportPreview = ref(false)
const aiImportBatch = ref<AiConversationImportBatch | null>(null)
const aiImportArchiveName = ref('')
const views = ref<ViewDefinition[]>([])
const taskRuns = ref<TaskRun[]>([])
const objectType = ref<KnowledgeObjectType>('rule')
const objectTitle = ref('')
const viewType = ref<ViewType>('query')
const viewName = ref('')
const viewQuery = ref('')
const generationPrompt = ref('')
const writebackPolicy = ref<ViewWritebackPolicy>('readonly')
const renders = ref<Record<string, string>>({})
const loading = ref(false)
const error = ref('')
const delegationGrant = ref('')
const activeGrant = ref<DelegationGrant | null>(null)
const activeDelegationRun = ref<TaskRun | null>(null)
const activeTab = defineModel<'knowledge' | 'assets' | 'views' | 'tasks'>('tab', {
  default: 'assets',
})
const cliExportPath = ref('')
const cliSubmissionPath = ref('')
const cliCapabilityToken = ref('')
const dialog = useDialog()
const message = useMessage()
function control(): Promise<KnowledgeControlService> {
  return props.getService()
}

async function refreshState(): Promise<void> {
  const state = await (await control()).load()
  objects.value = state.objects
  assets.value = state.assets ?? []
  views.value = state.views
  taskRuns.value = state.taskRuns
}

async function execute(action: () => Promise<void>, reload = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    await action()
    if (reload) await refreshState()
  } catch (actionError) {
    error.value = actionError instanceof Error ? actionError.message : String(actionError)
  } finally {
    loading.value = false
  }
}

function load(): Promise<void> {
  return execute(refreshState)
}

function verifyRun(run: TaskRun): Promise<void> {
  return execute(async () => (await control()).verifyRun(run), true)
}

function delegateRun(run: TaskRun): Promise<void> {
  return execute(async () => {
    const grant = await (await control()).delegateRun(run)
    activeGrant.value = grant
    activeDelegationRun.value = run
    cliCapabilityToken.value = grant.capabilityToken
    delegationGrant.value = JSON.stringify(
      {
        delegationId: grant.delegation.id,
        capabilityToken: grant.capabilityToken,
        expiresAt: grant.delegation.expiresAt,
      },
      null,
      2,
    )
  })
}

function exportCliEnvelope(): Promise<void> {
  const grant = activeGrant.value
  const run = activeDelegationRun.value
  const path = cliExportPath.value.trim()
  if (!grant || !run || !path) {
    return Promise.resolve()
  }
  return execute(async () => (await control()).exportCliEnvelope(path, grant, run))
}

function importCliSubmission(): Promise<void> {
  if (!cliSubmissionPath.value.trim() || !cliCapabilityToken.value.trim()) return Promise.resolve()
  return execute(
    async () =>
      (await control()).importCliSubmission(
        cliSubmissionPath.value.trim(),
        cliCapabilityToken.value.trim(),
      ),
    true,
  )
}

function createObject(): Promise<void> {
  if (!objectTitle.value.trim()) return Promise.resolve()
  return execute(async () => {
    await (
      await control()
    ).createKnowledgeObject({
      type: objectType.value,
      title: objectTitle.value,
      documentId: props.currentDocumentId,
      documentRevision: props.currentDocumentRevision,
    })
    objectTitle.value = ''
  }, true)
}

async function viewKnowledgeObject(object: KnowledgeObject): Promise<void> {
  selectedObjectDetail.value = null
  showObjectDetail.value = true
  await execute(async () => {
    selectedObjectDetail.value = await (await control()).getKnowledgeObjectDetail(object.id)
  })
}

async function saveKnowledgeObjectMetadata(input: {
  id: string
  expectedVersion: number
  category: string
  tags: string[]
}): Promise<void> {
  await execute(async () => {
    await (await control()).updateKnowledgeObjectMetadata(input)
    selectedObjectDetail.value = await (await control()).getKnowledgeObjectDetail(input.id)
    message.success('知识分类与内容已保存')
  }, true)
}

function createView(): Promise<void> {
  if (!viewName.value.trim() || (viewType.value === 'query' && !viewQuery.value.trim())) {
    return Promise.resolve()
  }
  return execute(async () => {
    const ai = loadAiSettings()
    await (
      await control()
    ).createView({
      name: viewName.value,
      type: viewType.value,
      query: viewQuery.value,
      prompt: generationPrompt.value,
      writebackPolicy: writebackPolicy.value,
      currentDocumentId: props.currentDocumentId,
      provider: ai.provider,
      model: ai.model,
    })
    viewName.value = ''
    viewQuery.value = ''
    generationPrompt.value = ''
  }, true)
}

async function importKnowledgeFile(file: BrowserFile): Promise<void> {
  assetImportNotice.value = ''
  await execute(async () => (await control()).importKnowledgeFile(file), true)
}

async function importAiConversation(conversationId: string): Promise<void> {
  const conversation = props.chatHistory.find((item) => item.id === conversationId)
  if (!conversation) return
  assetImportNotice.value = ''
  await execute(async () => (await control()).importAiConversation(conversation), true)
}

async function importAiConversationFile(file: BrowserFile): Promise<void> {
  assetImportNotice.value = ''
  let batch: AiConversationImportBatch | null = null
  await execute(async () => {
    batch = await (await control()).prepareAiConversationImport(file)
  })
  if (!batch) return
  if (batch.conversations.length === 0) {
    assetImportNotice.value = batch.failures.join('；') || '没有找到可导入的内容。'
    return
  }
  aiImportBatch.value = batch
  aiImportArchiveName.value = file.name
  showAiImportPreview.value = true
}

async function confirmAiConversationImport(
  selections: AiConversationImportSelection[],
): Promise<void> {
  const batch = aiImportBatch.value
  if (!batch) return
  let result: { imported: number; failures: string[] } | null = null
  await execute(async () => {
    result = await (
      await control()
    ).importAiConversationSelections(selections, batch.failures, aiImportArchiveName.value)
  }, true)
  if (!result) return
  const failedText = result.failures.length
    ? `，${result.failures.length} 个失败：${result.failures.slice(0, 3).join('；')}`
    : ''
  assetImportNotice.value = `已导入 ${result.imported} 项${failedText}`
  showAiImportPreview.value = false
  aiImportBatch.value = null
}

function openOriginalAsset(assetId: string): Promise<void> {
  return execute(async () => (await control()).openOriginalAsset(assetId))
}

function viewAsset(asset: KnowledgeAsset): void {
  selectedAsset.value = asset
  showAssetPreview.value = true
}

function confirmDeleteAsset(asset: KnowledgeAsset): void {
  dialog.warning({
    title: '删除知识资产',
    content: `确定删除“${asset.title}”吗？知识资产记录${asset.assetId ? '和保存的原文件' : ''}将被永久删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void execute(async () => {
        await (await control()).deleteKnowledgeAsset(asset)
        if (selectedAsset.value?.id === asset.id) {
          showAssetPreview.value = false
          selectedAsset.value = null
        }
        message.success('知识资产已删除')
      }, true)
    },
  })
}

function refreshView(view: ViewDefinition): Promise<void> {
  return execute(async () => {
    const render = await (await control()).refreshView(view.id)
    renders.value = { ...renders.value, [view.id]: JSON.stringify(render, null, 2) }
  }, true)
}

function protectViewOverride(view: ViewDefinition): Promise<void> {
  const content = renders.value[view.id]
    ? JSON.parse(renders.value[view.id])
    : { note: '用户手动覆盖' }
  return execute(async () => (await control()).protectViewOverride(view.id, content), true)
}

function proposeViewWriteback(view: ViewDefinition): Promise<void> {
  return execute(async () => (await control()).proposeViewWriteback(view), true)
}

function forkView(view: ViewDefinition): Promise<void> {
  return execute(async () => (await control()).forkView(view.id))
}

onMounted(load)
</script>

<template>
  <section class="operations-page knowledge-control-page" aria-label="知识控制">
    <header class="operations-page__header">
      <div>
        <h1>知识中心</h1>
        <p>管理知识资产、规则、智能视图与任务验收。</p>
      </div>
      <NButton secondary :loading="loading" @click="load">
        <template #icon
          ><NIcon :size="15"><RefreshCw /></NIcon
        ></template>
        刷新
      </NButton>
    </header>

    <div class="operations-page__content p1-domain-grid">
      <p v-if="error" class="operations-error" role="alert">{{ error }}</p>
      <nav v-if="!contextNavigation" class="surface-tabs" role="tablist" aria-label="知识中心功能">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'assets'"
          :class="{ 'is-active': activeTab === 'assets' }"
          @click="activeTab = 'assets'"
        >
          <Database :size="17" /><span
            ><strong>知识资产</strong><small>导入文件与 AI 对话</small></span
          ><em>{{ assets.length }}</em>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'knowledge'"
          :class="{ 'is-active': activeTab === 'knowledge' }"
          @click="activeTab = 'knowledge'"
        >
          <ShieldCheck :size="17" /><span
            ><strong>知识规则</strong><small>保存规则、决策和证据</small></span
          ><em>{{ objects.length }}</em>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'views'"
          :class="{ 'is-active': activeTab === 'views' }"
          @click="activeTab = 'views'"
        >
          <BookOpenCheck :size="17" /><span
            ><strong>智能视图</strong><small>汇总和重组已有知识</small></span
          ><em>{{ views.length }}</em>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'tasks'"
          :class="{ 'is-active': activeTab === 'tasks' }"
          @click="activeTab = 'tasks'"
        >
          <ListChecks :size="17" /><span
            ><strong>任务验收</strong><small>检查结果与外部协作</small></span
          ><em>{{ taskRuns.length }}</em>
        </button>
      </nav>

      <KnowledgeObjectsPanel
        v-if="activeTab === 'knowledge'"
        v-model:object-type="objectType"
        v-model:title="objectTitle"
        :objects="objects"
        :loading="loading"
        @create="createObject"
        @view="viewKnowledgeObject"
      />
      <KnowledgeAssetsPanel
        v-else-if="activeTab === 'assets'"
        :assets="assets"
        :conversations="chatHistory"
        :loading="loading"
        :import-notice="assetImportNotice"
        @import-file="importKnowledgeFile"
        @import-chat="importAiConversation"
        @import-chat-file="importAiConversationFile"
        @view="viewAsset"
        @open-original="openOriginalAsset"
        @delete="confirmDeleteAsset"
        @research="emit('researchAssets', $event)"
      />
      <ViewsPanel
        v-else-if="activeTab === 'views'"
        v-model:view-type="viewType"
        v-model:name="viewName"
        v-model:query="viewQuery"
        v-model:prompt="generationPrompt"
        v-model:writeback-policy="writebackPolicy"
        :views="views"
        :renders="renders"
        :loading="loading"
        @create="createView"
        @refresh="refreshView"
        @override="protectViewOverride"
        @propose="proposeViewWriteback"
        @fork="forkView"
      />
      <TaskRunsPanel
        v-else
        v-model:export-path="cliExportPath"
        v-model:submission-path="cliSubmissionPath"
        v-model:capability-token="cliCapabilityToken"
        :task-runs="taskRuns"
        :loading="loading"
        :delegation-grant="delegationGrant"
        :has-active-grant="Boolean(activeGrant)"
        @verify="verifyRun"
        @delegate="delegateRun"
        @export="exportCliEnvelope"
        @import="importCliSubmission"
      />
      <KnowledgeAssetPreviewModal
        v-if="showAssetPreview"
        v-model:show="showAssetPreview"
        :asset="selectedAsset"
        @open-original="openOriginalAsset"
        @delete="confirmDeleteAsset"
      />
      <AiConversationImportPreviewModal
        v-if="aiImportBatch"
        v-model:show="showAiImportPreview"
        :candidates="aiImportBatch.conversations"
        :failures="aiImportBatch.failures"
        :archive-name="aiImportArchiveName"
        :loading="loading"
        @confirm="confirmAiConversationImport"
      />
    </div>

    <KnowledgeObjectDetailModal
      v-if="showObjectDetail"
      v-model:show="showObjectDetail"
      :detail="selectedObjectDetail"
      :loading="loading"
      @save="saveKnowledgeObjectMetadata"
    />
  </section>
</template>
