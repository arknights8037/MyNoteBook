<script setup lang="ts">
import { BookOpenCheck, RefreshCw } from '@lucide/vue'
import { onMounted, ref } from 'vue'

import { createKnowledgeControlService } from '@/infrastructure/database/knowledgeControlServiceFactory'
import { loadAiSettings } from '@/models/ai'
import type { DelegationGrant } from '@/models/governance'
import type { KnowledgeObject, KnowledgeObjectType } from '@/models/knowledge'
import type { ViewDefinition, ViewType, ViewWritebackPolicy } from '@/models/view'
import type { TaskRun } from '@/models/work'
import type { KnowledgeControlService } from '@/services/KnowledgeControlService'
import KnowledgeObjectsPanel from './knowledge-control/KnowledgeObjectsPanel.vue'
import TaskRunsPanel from './knowledge-control/TaskRunsPanel.vue'
import ViewsPanel from './knowledge-control/ViewsPanel.vue'
import { NButton, NIcon } from '@/ui'

const props = defineProps<{ currentDocumentId: string; currentDocumentRevision: number }>()
const objects = ref<KnowledgeObject[]>([])
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
const cliExportPath = ref('')
const cliSubmissionPath = ref('')
const cliCapabilityToken = ref('')
let controlPromise: Promise<KnowledgeControlService> | null = null

function control(): Promise<KnowledgeControlService> {
  controlPromise ??= createKnowledgeControlService()
  return controlPromise
}

async function refreshState(): Promise<void> {
  const state = await (await control()).load()
  objects.value = state.objects
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
    delegationGrant.value = JSON.stringify({
      delegationId: grant.delegation.id,
      capabilityToken: grant.capabilityToken,
      expiresAt: grant.delegation.expiresAt,
    }, null, 2)
  })
}

function exportCliEnvelope(): Promise<void> {
  const grant = activeGrant.value
  const run = activeDelegationRun.value
  const path = cliExportPath.value.trim()
  if (!grant || !run || !path) {
    return Promise.resolve()
  }
  return execute(async () =>
    (await control()).exportCliEnvelope(path, grant, run),
  )
}

function importCliSubmission(): Promise<void> {
  if (!cliSubmissionPath.value.trim() || !cliCapabilityToken.value.trim()) return Promise.resolve()
  return execute(async () =>
    (await control()).importCliSubmission(
      cliSubmissionPath.value.trim(),
      cliCapabilityToken.value.trim(),
    ), true)
}

function createObject(): Promise<void> {
  if (!objectTitle.value.trim()) return Promise.resolve()
  return execute(async () => {
    await (await control()).createKnowledgeObject({
      type: objectType.value,
      title: objectTitle.value,
      documentId: props.currentDocumentId,
      documentRevision: props.currentDocumentRevision,
    })
    objectTitle.value = ''
  }, true)
}

function createView(): Promise<void> {
  if (!viewName.value.trim() || (viewType.value === 'query' && !viewQuery.value.trim())) {
    return Promise.resolve()
  }
  return execute(async () => {
    const ai = loadAiSettings()
    await (await control()).createView({
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
        <span class="operations-page__eyebrow"><BookOpenCheck :size="15" />KNOWLEDGE CONTROL</span>
        <h1>知识对象与视图</h1>
        <p>规范知识保持锚定；视图只保存查询、依赖和可重建快照。</p>
      </div>
      <NButton secondary :loading="loading" @click="load">
        <template #icon><NIcon :size="15"><RefreshCw /></NIcon></template>
        刷新
      </NButton>
    </header>

    <div class="operations-page__content p1-domain-grid">
      <p v-if="error" class="operations-error" role="alert">{{ error }}</p>
      <KnowledgeObjectsPanel
        v-model:object-type="objectType"
        v-model:title="objectTitle"
        :objects="objects"
        :loading="loading"
        @create="createObject"
      />
      <ViewsPanel
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
    </div>
  </section>
</template>
