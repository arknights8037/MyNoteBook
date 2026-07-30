import { computed, ref, shallowReactive } from 'vue'

import type { AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import type { ContextBundle } from '@/models/agent/contextBundle'
import type {
  AgentRuntimeEvent,
  AgentSidecarFinalizationV1,
  AgentSidecarSubmissionV1,
} from '@/models/agent/agentRuntimeContract'
import type { AgentToolCall } from '@/models/agent/agentTool'
import type { AgentTask } from '@/models/agent/agent'
import type { AgentRuntimeClient } from '@/services/agent/AgentRuntimeClient'
import type { KnowledgeSource } from '@/models/knowledge/knowledgeRetrieval'
import { createIdleAgentRuntimeState } from '@/models/agent/agentRuntime'
import { buildAiPrompt } from '@/services/ai/AiPromptPolicy'
import { normalizeDocumentTitle } from '@/models/documents/documentPresentation'
import { buildAgentRunContext } from './agentRun/agentRunContext'
import type { AgentCommunicationResult } from '@/services/agent/AgentCommunicationService'
import type {
  AgentRunContinuation,
  AgentRunSession,
  AgentRunSnapshot,
  UseAgentRunOptions,
} from './agentRun/types'
import { compileContextBundle } from '@/models/agent/contextBundle'
import { auditConfiguredModelParameters } from '@/models/agent/providerCapabilities'
import { prepareAgentRunExecution } from '@/services/agent/AgentRunExecution'
import { resolveAgentOutputTokenLimit } from '@/services/agent/AgentToolRegistry'
import { prepareCognitiveRun } from '@/services/cognitive/CognitiveRunService'
import {
  compileLearningStateContext,
  createInitialLearningTurn,
} from '@/services/cognitive/LearningSessionStateService'
import type { LearningSessionState } from '@/models/cognitive/cognitive'
import { formatAiErrorMessage } from '@/services/ai/AiErrorMessage'
import {
  buildContinuationPrompt,
  compileConversationContinuationContext,
  createPersistableRuntimeSnapshot,
  projectKnowledgeForBundle,
  resolveWorkspaceDocumentIds,
  selectRelevantApprovedKnowledge,
} from './agentRun/agentRunSupport'
import { createAgentRunRuntimeController } from './agentRun/agentRunRuntimeController'
import { describeAgentRunCompletion } from './agentRun/agentRunIntentStrategy'
import { prepareAgentRun, type AgentEditPlan } from './agentRun/agentRunPreparation'
import {
  createExecuteToolCallback,
  type ReadableDocument,
} from './agentRun/agentRunToolExecutorFactory'
import {
  resolveAgentRunOutput,
  type AgentRunOutputResolution,
} from './agentRun/agentRunOutputResolution'

export {
  compileConversationContinuationContext,
  selectRelevantApprovedKnowledge,
} from './agentRun/agentRunSupport'

export type {
  AgentRunServiceDependencies,
  AgentRunDocumentAdapter,
  AgentRunDocumentSnapshot,
  AgentRunPatchWorkflow,
  AgentRunContinuation,
  UseAgentRunOptions,
  AgentRunSession,
} from './agentRun/types'

interface SidecarRunRecoveryContextV1 {
  version: 1
  kind: 'agent_run_output'
  mode: 'agent'
  agentIntent: string
  snapshot: Omit<AgentRunSnapshot, 'settings'>
  editPlan: AgentEditPlan
  sources: KnowledgeSource[]
  readableDocuments: ReadableDocument[]
  cognitive: {
    spec: ReturnType<typeof prepareCognitiveRun>['spec']
    session: { id: string; version: number } | null
    learningState: LearningSessionState | null
    learningStateBeforeRun: LearningSessionState | null
    learningUserAttempt: string | null
    resumedLearningSession: boolean
  } | null
}

let agentRunModulesPromise: ReturnType<typeof loadAgentRunModulesUncached> | null = null

function loadAgentRunModules() {
  return (agentRunModulesPromise ??= loadAgentRunModulesUncached())
}

async function loadAgentRunModulesUncached() {
  const [
    { runAiMarkdownCompletion },
    { buildAiSystemPrompt },
    { AiSdkAgentRuntimeAdapter },
    { TauriAgentRuntimeAdapter },
    { AgentRuntimeClient },
    { buildDomainToolManifest },
    { executeAgentTool, prepareReadDocumentObservation },
    { executeRustAgentTool },
    { loadEnabledSkillPrompt },
    { parseReadDocumentProvenance, validateDocumentEditProvenance },
    { getAgentOutputContract },
  ] = await Promise.all([
    import('@/services/ai/AiMarkdownService'),
    import('@/services/ai/AiSystemPrompt'),
    import('@/services/ai/AiSdkAgentRuntime'),
    import('@/infrastructure/runtime/TauriAgentRuntimeAdapter'),
    import('@/services/agent/AgentRuntimeClient'),
    import('@/services/agent/DomainToolManifest'),
    import('@/services/agent/AgentToolExecutor'),
    import('@/services/agent/RustAgentToolService'),
    import('@/services/integrations/SkillService'),
    import('@/services/agent/AgentEditProposalGuard'),
    import('@/services/cognitive/CognitiveRegistry'),
  ])
  return {
    runAiMarkdownCompletion,
    buildAiSystemPrompt,
    AiSdkAgentRuntimeAdapter,
    TauriAgentRuntimeAdapter,
    AgentRuntimeClient,
    buildDomainToolManifest,
    executeAgentTool,
    prepareReadDocumentObservation,
    executeRustAgentTool,
    loadEnabledSkillPrompt,
    parseReadDocumentProvenance,
    validateDocumentEditProvenance,
    getAgentOutputContract,
  }
}

export function useAgentRun(options: UseAgentRunOptions) {
  type RuntimeController = ReturnType<typeof createAgentRunRuntimeController>
  const fallbackRuntime = createAgentRunRuntimeController(options.createId)
  const runtimes = shallowReactive(new Map<string, RuntimeController>())
  const activeRuns = shallowReactive(
    new Map<
      string,
      {
        abortController: AbortController
        runtime: RuntimeController
        runtimeClient?: AgentRuntimeClient
        runtimeRunId?: string
        unsubscribeRuntime?: () => void
      }
    >(),
  )
  const lastTaskId = ref<string | null>(null)
  const lastRunIssue = ref('')
  const lastRunReport = ref<AgentCommunicationResult | null>(null)
  const activeConversationId = ref<string | null>(null)
  const selectedConversationId = computed(() =>
    options.workspace ? options.workspace.conversationId.value : activeConversationId.value,
  )
  const selectedRuntime = computed(
    () => runtimes.get(selectedConversationId.value ?? '') ?? fallbackRuntime,
  )
  const runtimeState = computed(() => selectedRuntime.value.runtimeState.value)
  const lifecycleState = computed(() => selectedRuntime.value.lifecycleState.value)
  const runEvents = computed(() => selectedRuntime.value.runEvents.value)
  const hasCognitivePersistence = () => Boolean(options.services?.getCognitiveSessionService)
  const getCognitiveSessionService = async () => {
    const provider = options.services?.getCognitiveSessionService
    if (!provider) throw new Error('当前运行环境未提供 Cognitive Session 持久化服务。')
    return provider()
  }

  async function run(
    promptOverride?: string,
    continuation?: AgentRunContinuation,
    session?: AgentRunSession,
  ): Promise<void> {
    const runContext = session ?? options
    const failRun = (error: string): void => {
      runContext.error.value = error
      options.notify.error(error)
    }
    const basePrompt = promptOverride?.trim() || runContext.prompt.value.trim()
    const prompt = continuation ? buildContinuationPrompt(basePrompt, continuation) : basePrompt
    if (!prompt) {
      lastRunIssue.value = 'Agent 请求内容为空。'
      return
    }
    const workspace = runContext.workspace ?? options.workspace
    const runKey =
      workspace?.conversationId.value?.trim() ||
      workspace?.ensureConversationId() ||
      options.createId()
    if (activeRuns.has(runKey)) {
      lastRunIssue.value = '当前任务已经在运行。'
      return
    }
    lastTaskId.value = null
    lastRunIssue.value = ''
    lastRunReport.value = null
    const runId = options.createId()
    const abortController = new AbortController()
    const runtime = createAgentRunRuntimeController(options.createId)
    const {
      runtimeState,
      waitForAuthorizerInput,
      cancelPendingAuthorization,
      applyProgressUpdate,
      recordExecutionResult,
      setSummary,
    } = runtime
    runtimes.set(runKey, runtime)
    activeRuns.set(runKey, { abortController, runtime })
    activeConversationId.value = runKey
    options.isRunning.value = true
    runtime.start({ runId, goal: prompt, detail: '正在准备 Agent 任务' })

    const originalPrompt = prompt
    let prepared
    try {
      prepared = await prepareAgentRun({
        originalPrompt,
        continuation,
        session,
        runContext,
        options,
        runId,
        hasCognitivePersistence: hasCognitivePersistence(),
        getCognitiveSessionService,
      })
    } catch (error) {
      const message = formatAiErrorMessage(error)
      failRun(message)
      runtime.fail(message)
      finishRun(runKey, runtime)
      return
    }
    if (!prepared.ok) {
      failRun(prepared.error)
      runtime.fail(prepared.error)
      finishRun(runKey, runtime)
      return
    }
    const {
      snapshot,
      slashCommand,
      priorConversationMessages,
      conversationId,
      mode,
      editPlan,
      resumedLearningSession,
    } = prepared.value
    const { agentIntent, learningStateBeforeRun, learningUserAttempt } = prepared.value
    let { cognitiveSession, learningState } = prepared.value
    activeConversationId.value = conversationId || runKey

    const {
      runAiMarkdownCompletion,
      buildAiSystemPrompt,
      AiSdkAgentRuntimeAdapter,
      TauriAgentRuntimeAdapter,
      AgentRuntimeClient,
      buildDomainToolManifest,
      executeAgentTool,
      prepareReadDocumentObservation,
      executeRustAgentTool,
      loadEnabledSkillPrompt,
      parseReadDocumentProvenance,
      validateDocumentEditProvenance,
    } = await loadAgentRunModules()
    const sidecarOwned = options.services?.runtimeOwner === 'rust_worker'
    let sources: KnowledgeSource[] = []
    let agentRounds = 0
    let agentToolCallCount = 0
    let agentDiagnostics: Pick<AgentRuntimeResult, 'finishReason' | 'usage'> = {}
    let acknowledgeSidecarTerminal: (() => Promise<void>) | null = null
    const workspaceDocumentIds = resolveWorkspaceDocumentIds(
      snapshot.document.documents,
      snapshot.workspace?.rootDocumentIds ?? [],
    )
    workspaceDocumentIds.add(snapshot.document.id)
    const discoveredDocumentIds = new Set(workspaceDocumentIds)
    const readableDocuments = new Map<string, ReadableDocument>()
    const taskApprovedMcpServerIds = new Set<string>()
    let runtimeContextBundle: ContextBundle | null = null

    if (editPlan) lastTaskId.value = editPlan.task.id

    const assistantMessage = {
      id: options.createId(),
      role: 'assistant' as const,
      mode,
      content: '',
      reasoningContent: '',
      sources: [],
      agentRuntime: undefined,
      status: 'streaming' as const,
    }
    runContext.messages.value.push({
      id: options.createId(),
      role: 'user',
      mode,
      content: slashCommand?.originalPrompt ?? snapshot.prompt,
      status: 'done',
    })
    runContext.messages.value.push(assistantMessage)
    const assistantIndex = runContext.messages.value.length - 1
    runContext.prompt.value = ''
    options.isRunning.value = true
    runContext.workspace?.requestConversationTitle?.(conversationId, snapshot.prompt)
    runContext.error.value = ''
    runtime.beginExecution(mode === 'agent' ? '正在准备 Agent 任务' : '正在准备文档上下文')
    const syncRuntimeMessage = (): void => {
      const message = runContext.messages.value[assistantIndex]
      if (!message || message.role !== 'assistant') return
      message.agentRuntime = createPersistableRuntimeSnapshot(runtimeState.value)
    }

    try {
      if (continuation && !sidecarOwned) {
        for (const documentId of new Set(continuation.patches.map((patch) => patch.documentId))) {
          const targetBlockIds = continuation.patches
            .filter((patch) => patch.documentId === documentId)
            .flatMap((patch) => patch.targetBlockIds)
          const rawToolResult = await executeRustAgentTool(
            'read_document',
            { documentId, blockIds: [...new Set(targetBlockIds)] },
            undefined,
            abortController.signal,
          )
          const toolResult = prepareReadDocumentObservation(rawToolResult)
          const provenance = parseReadDocumentProvenance(toolResult, documentId)
          if (!provenance) {
            throw new Error(`无法恢复修订提案的 canonical provenance：${documentId}`)
          }
          readableDocuments.set(documentId, provenance)
        }
      }
      const context = sidecarOwned
        ? { text: '', sources: [] as KnowledgeSource[] }
        : await buildAgentRunContext({
            snapshot,
            mode,
            targetBlocks: editPlan?.targetBlocks,
            document: options.document,
          })
      if (!sidecarOwned) {
        const conversationContext =
          compileConversationContinuationContext(priorConversationMessages)
        if (conversationContext) {
          context.text += `\n\n${conversationContext}`
        }
      }
      sources = context.sources
      assistantMessage.sources = sources
      const skillPrompt = await loadEnabledSkillPrompt().catch(() => ({
        catalog: '',
        instructions: '',
        skills: [],
      }))
      const effectiveKnowledge =
        !sidecarOwned && options.services?.getKnowledgeRepository
          ? await options.services
              .getKnowledgeRepository()
              .then(async (repository) => {
                const result = await repository.listObjects({
                  types: ['rule', 'decision'],
                  documentId: snapshot.document.id,
                  effectiveAt: Date.now(),
                  limit: 100,
                })
                return result.ok ? result.value : []
              })
              .catch(() => [])
          : []
      const approvedReferenceKnowledge =
        !sidecarOwned && options.services?.getKnowledgeRepository
          ? await options.services
              .getKnowledgeRepository()
              .then(async (repository) => {
                const result = await repository.listObjects({
                  types: [
                    'claim',
                    'evidence',
                    'inference',
                    'assumption',
                    'concept',
                    'question',
                    'limitation',
                    'fact',
                  ],
                  effectiveAt: Date.now(),
                  limit: 80,
                })
                return result.ok
                  ? selectRelevantApprovedKnowledge(result.value, snapshot.prompt)
                  : []
              })
              .catch(() => [])
          : []
      if (effectiveKnowledge.length > 0) {
        context.text += [
          '',
          '当前有效的结构化规则与决策：',
          ...effectiveKnowledge.map(
            (object) =>
              `- [${object.objectType}] ${object.title} (id=${object.id}, version=${object.version}, authority=${object.authorityLevel})`,
          ),
          '以上对象是正式上下文约束；如与文档片段冲突，必须指出冲突，不得自行忽略。',
        ].join('\n')
      }
      if (approvedReferenceKnowledge.length > 0) {
        context.text += [
          '',
          '用户已确认的参考知识：',
          ...approvedReferenceKnowledge.map(
            (object) =>
              `- [${object.objectType}] ${object.title}: ${object.content.slice(0, 1_200)} (id=${object.id}, version=${object.version}, validation=${String(object.structuredData.validationStatus ?? 'unknown')})`,
          ),
          '这些对象可用于检索、比较和写作，但不是强制规则。保留其验证状态；unverified 或 warning 内容不得改写成确定事实。',
        ].join('\n')
      }
      if (editPlan && !sidecarOwned) {
        const bundleSources =
          mode === 'agent' || sources.some((source) => source.documentId === snapshot.document.id)
            ? sources
            : [
                {
                  id: 'S1',
                  documentId: snapshot.document.id,
                  documentTitle: normalizeDocumentTitle(snapshot.document.title),
                  contentSnippet: snapshot.document.markdown || snapshot.document.text,
                  score: Number.MAX_SAFE_INTEGER,
                  isCurrentDocument: true,
                  revision: snapshot.document.revision ?? editPlan.expectedRevision,
                },
                ...sources,
              ]
        const contextBundle = await compileContextBundle({
          id: options.createId(),
          taskId: editPlan.task.id,
          correlationId: editPlan.task.correlationId,
          causationId: editPlan.task.causationId,
          query: snapshot.prompt,
          documentId: snapshot.document.id,
          contextScope: editPlan.task.contextScope,
          currentRevision: snapshot.document.revision ?? editPlan.expectedRevision,
          provider: snapshot.settings.provider,
          model: snapshot.settings.model,
          executionPolicy: editPlan.task.executionPolicy,
          sources: bundleSources.map((source) => ({
            documentId: source.documentId,
            blockId: source.blockId,
            documentTitle: source.documentTitle,
            revision: source.revision ?? 0,
            contentSnippet: source.contentSnippet,
          })),
          activeRules: effectiveKnowledge
            .filter((object) => object.objectType === 'rule')
            .map(projectKnowledgeForBundle),
          decisions: effectiveKnowledge
            .filter((object) => object.objectType === 'decision')
            .map(projectKnowledgeForBundle),
        })
        const parameterAudit = auditConfiguredModelParameters(snapshot.settings)
        const actualParameters = { ...parameterAudit.actual }
        if (mode === 'agent') delete actualParameters.reasoningEffort
        const savedBundle = await (
          await options.patches.getRepository()
        ).saveContextBundle(contextBundle, {
          provider: snapshot.settings.provider,
          modelParameters: {
            requested: parameterAudit.requested,
            actual: {
              ...actualParameters,
              maxOutputTokens: resolveAgentOutputTokenLimit(
                snapshot.settings.maxTokens,
                editPlan.task.executionPolicy,
              ),
              toolCalling: mode === 'agent',
            },
          },
          ignoredParameters: Array.from(
            new Set([
              ...parameterAudit.ignored,
              ...(mode === 'agent' && snapshot.settings.reasoningEffort !== 'auto'
                ? ['reasoningEffort']
                : []),
            ]),
          ),
          skillVersions: skillPrompt.skills ?? [],
        })
        if (!savedBundle.ok) throw new Error(savedBundle.error.message)
        editPlan.task.contextBundleId = contextBundle.id
        runtimeContextBundle = contextBundle
      }
      const mcpRuntimeTools =
        !sidecarOwned && mode === 'agent' && options.services?.mcpClient
          ? await options.services.mcpClient
              .listTools()
              .then(async (tools) => {
                const { createMcpRuntimeTools } = await import('@/models/integrations/mcp')
                return createMcpRuntimeTools(tools)
              })
              .catch(() => [])
          : []
      const systemPrompt = [
        buildAiSystemPrompt(
          snapshot.settings.systemPrompt,
          mode,
          skillPrompt,
          slashCommand?.command.systemInstruction,
        ),
        continuation
          ? '这是现有提案的受控修订。canonical provenance 已由 Runtime 恢复；不得搜索、读取其他文档或重新执行发现流程。根据反馈保留正确 Patch、修正错误 Patch，并通过 submit_document_edits 一次提交完整替代提案。'
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      const cognitiveRun =
        (agentIntent === 'research' || agentIntent === 'review' || agentIntent === 'learning') &&
        editPlan
          ? prepareCognitiveRun({
              modeId: agentIntent,
              baseExecutionPolicy: editPlan.task.executionPolicy,
              externalTools: mcpRuntimeTools,
              baseSafety: systemPrompt,
              skillInstructions: skillPrompt.instructions,
              task: snapshot.prompt,
              context:
                agentIntent === 'learning' && learningState
                  ? `${context.text}\n\n${compileLearningStateContext(learningState, learningUserAttempt)}`
                  : context.text,
            })
          : null
      const runtimeExecution = editPlan
        ? prepareAgentRunExecution({
            prompt: snapshot.prompt,
            context: context.text,
            systemPrompt: cognitiveRun?.systemPrompt ?? systemPrompt,
            intent: agentIntent,
            executionPolicy: cognitiveRun?.spec.executionPolicy ?? editPlan.task.executionPolicy,
            externalTools: mcpRuntimeTools,
            ...(cognitiveRun ? { outputContract: cognitiveRun.outputContract } : {}),
          })
        : null
      if (cognitiveRun && editPlan) {
        if (resumedLearningSession && cognitiveSession && hasCognitivePersistence()) {
          const resumed = await (
            await getCognitiveSessionService()
          ).resume(cognitiveSession.id, cognitiveSession.version)
          if (!resumed.ok) throw new Error(resumed.error.message)
          cognitiveSession = resumed.value
        }
        if (!cognitiveSession) {
          const sessionId = options.createId()
          const startedAt = Date.now()
          const sessionInput = {
            id: sessionId,
            conversationId: snapshot.workspace?.conversationId || conversationId || sessionId,
            modeId: cognitiveRun.spec.modeId,
            modeVersion: cognitiveRun.spec.modeVersion,
            templateId: cognitiveRun.spec.templateId,
            templateVersion: cognitiveRun.spec.templateVersion,
            skillIds: cognitiveRun.spec.skillIds,
            targetDocumentIds:
              snapshot.explicitTargets.length > 0
                ? snapshot.explicitTargets
                    .filter((target) => target.kind === 'document')
                    .map((target) => target.id)
                : snapshot.document.id
                  ? [snapshot.document.id]
                  : [],
            targetBlockIds: snapshot.document.selectedBlocks.map((block) => block.id),
            state: learningState ?? { runId: editPlan.task.id, phase: 'running' },
            createdAt: startedAt,
          } as const
          if (hasCognitivePersistence()) {
            const started = await (await getCognitiveSessionService()).start(sessionInput)
            if (!started.ok) throw new Error(started.error.message)
            cognitiveSession = started.value
          } else {
            cognitiveSession = {
              ...sessionInput,
              status: 'active',
              version: 1,
              createdAt: startedAt,
              updatedAt: startedAt,
            }
          }
        }
      }
      const handleDelta = (delta: string, channel: 'content' | 'reasoning' = 'content') => {
        const currentMessage = runContext.messages.value[assistantIndex]
        if (!currentMessage) return
        if (channel === 'reasoning') {
          currentMessage.reasoningContent = (currentMessage.reasoningContent ?? '') + delta
        } else if (mode === 'ask' || (mode === 'agent' && !cognitiveRun)) {
          currentMessage.content += delta
        }
      }
      const projectRuntimeEvent = (event: AgentRuntimeEvent): void => {
        if (event.type === 'message.progress') {
          const delta = typeof event.payload.delta === 'string' ? event.payload.delta : ''
          const channel = event.payload.channel === 'reasoning' ? 'reasoning' : 'content'
          if (delta) handleDelta(delta, channel)
          return
        }
        if (event.type === 'run.progress') {
          const detail = typeof event.payload.detail === 'string' ? event.payload.detail : ''
          const phase = event.payload.phase
          if (
            phase !== 'planning' &&
            phase !== 'tool_running' &&
            phase !== 'tool_completed' &&
            phase !== 'finalizing'
          ) {
            return
          }
          if (editPlan && editPlan.task.status === 'running') editPlan.task.currentStep = detail
          applyProgressUpdate({
            phase,
            detail,
            ...(typeof event.payload.toolName === 'string'
              ? { toolName: event.payload.toolName }
              : {}),
            ...(event.payload.timelineEvent && typeof event.payload.timelineEvent === 'object'
              ? {
                  timelineEvent: event.payload.timelineEvent as Parameters<
                    typeof applyProgressUpdate
                  >[0]['timelineEvent'],
                }
              : {}),
          })
          syncRuntimeMessage()
          return
        }
        if (event.type.startsWith('tool.')) {
          const call = event.payload.toolCall as AgentToolCall | undefined
          if (!call) return
          applyProgressUpdate({
            phase: call.status === 'completed' ? 'tool_completed' : 'tool_running',
            toolName: call.toolName,
            detail: call.error || call.toolName,
            toolCall: call,
          })
          syncRuntimeMessage()
        }
      }
      runtime.beginExecution(
        mode === 'agent' ? '正在规划任务' : mode === 'edit' ? '正在生成修改提案' : '正在生成回答',
      )
      let runtimeAuthorizationBridge: {
        requestAuthorization: (
          runId: string,
          request: {
            id?: string
            question: string
            context: string
            options: string[]
            allowFreeText: boolean
          },
        ) => Promise<string>
      } | null = null
      let sidecarFinalization: AgentSidecarFinalizationV1 | undefined
      const executeToolCallback = editPlan
        ? createExecuteToolCallback({
            snapshot,
            editPlan,
            options,
            mcpRuntimeTools,
            taskApprovedMcpServerIds,
            workspaceDocumentIds,
            discoveredDocumentIds,
            readableDocuments,
            waitForAuthorizerInput: (request, task) =>
              runtimeAuthorizationBridge
                ? runtimeAuthorizationBridge.requestAuthorization(task.runId, request)
                : waitForAuthorizerInput(request, task),
            executeAgentTool,
            executeRustAgentTool,
            parseReadDocumentProvenance,
          })
        : null
      const output =
        agentIntent === 'learning' &&
        !resumedLearningSession &&
        learningState?.attempts.length === 0
          ? JSON.stringify(createInitialLearningTurn(learningState.topic))
          : mode === 'agent' && editPlan
            ? await (async () => {
                if (!sidecarOwned && !runtimeContextBundle) {
                  throw new Error('Agent Runtime 缺少 Context Bundle。')
                }
                const recoveryContext: SidecarRunRecoveryContextV1 | undefined = sidecarOwned
                  ? {
                      version: 1,
                      kind: 'agent_run_output',
                      mode: 'agent',
                      agentIntent,
                      snapshot: {
                        prompt: snapshot.prompt,
                        requestedMode: snapshot.requestedMode,
                        document: snapshot.document,
                        explicitTargets: snapshot.explicitTargets,
                        workspace: snapshot.workspace,
                      },
                      editPlan,
                      sources,
                      readableDocuments: [...readableDocuments.values()],
                      cognitive: cognitiveRun
                        ? {
                            spec: cognitiveRun.spec,
                            session: cognitiveSession,
                            learningState,
                            learningStateBeforeRun,
                            learningUserAttempt,
                            resumedLearningSession,
                          }
                        : null,
                    }
                  : undefined
                const adapter = sidecarOwned
                  ? new TauriAgentRuntimeAdapter({
                      dataDirectory: options.services?.runtimeDataDirectory?.(),
                      recoveryContext,
                      requestAuthorizerInput: (request) =>
                        waitForAuthorizerInput(
                          {
                            id: request.authorizationId,
                            question: request.question,
                            context: request.context,
                            options: request.options,
                            allowFreeText: request.allowFreeText,
                          },
                          editPlan.task,
                        ),
                    })
                  : new AiSdkAgentRuntimeAdapter({
                      createId: options.createId,
                      resolveCredential: async () => snapshot.settings.apiKey,
                      executeTool: executeToolCallback!,
                      recordToolCall: async (call) => {
                        const result = await (
                          await options.patches.getRepository()
                        ).recordToolCall(call)
                        if (!result.ok) throw new Error(result.error.message)
                      },
                      requestAuthorizerInput: (request) =>
                        waitForAuthorizerInput(request, editPlan.task),
                      answerAuthorization: runtime.answerAuthorization,
                      resolveOutputContract: (descriptor) => {
                        const contract = cognitiveRun?.outputContract
                        return contract &&
                          contract.id === descriptor.id &&
                          contract.version === descriptor.version
                          ? contract
                          : null
                      },
                      validateDocumentEditProposal: (proposal) =>
                        validateDocumentEditProvenance(proposal, [...readableDocuments.values()]),
                    })
                if (sidecarOwned && adapter instanceof TauriAgentRuntimeAdapter) {
                  acknowledgeSidecarTerminal = () => adapter.acknowledgeRun(editPlan.task.runId)
                }
                runtimeAuthorizationBridge = sidecarOwned ? null : adapter
                const client = new AgentRuntimeClient(adapter)
                const active = activeRuns.get(runKey)
                if (active) {
                  active.runtimeClient = client
                  active.runtimeRunId = editPlan.task.runId
                }
                const unsubscribe = (sidecarOwned ? adapter : client).subscribeEvents(
                  editPlan.task.runId,
                  (event) => {
                    projectRuntimeEvent(event)
                  },
                )
                if (active) active.unsubscribeRuntime = unsubscribe
                const result = sidecarOwned
                  ? await adapter.startSubmission({
                      version: 1,
                      runId: editPlan.task.runId,
                      workItemId: editPlan.task.id,
                      ...(editPlan.task.workflowId ? { workflowId: editPlan.task.workflowId } : {}),
                      sessionId: editPlan.task.sessionId,
                      document: {
                        id: snapshot.document.id,
                        title: snapshot.document.title,
                        tags: [...snapshot.document.tags],
                        sourceUrl: snapshot.document.sourceUrl,
                        author: snapshot.document.author,
                        text: snapshot.document.text,
                        markdown: snapshot.document.markdown,
                        revision: snapshot.document.revision,
                        blocks: snapshot.document.blocks.map((block) => ({ ...block })),
                        selectedBlockIds: snapshot.document.selectedBlocks.map((block) => block.id),
                        documents: snapshot.document.documents.map((document) => ({
                          id: document.id,
                          title: document.title,
                          documentKind: document.documentKind,
                          isDeleted: document.isDeleted,
                          parentId: document.parentId,
                        })),
                      },
                      workspace: {
                        projectId: snapshot.workspace?.projectId ?? '',
                        projectName: snapshot.workspace?.projectName ?? '未分组 Agent 项目',
                        rootDocumentIds: [...(snapshot.workspace?.rootDocumentIds ?? [])],
                        conversationId:
                          snapshot.workspace?.conversationId ?? editPlan.task.sessionId,
                      },
                      objective: snapshot.prompt,
                      intent: agentIntent,
                      systemInstructions: systemPrompt,
                      skillInstructions: skillPrompt.instructions,
                      modelPolicy: {
                        provider: snapshot.settings.provider,
                        model: snapshot.settings.model,
                        endpoint: snapshot.settings.endpoint,
                        temperature: snapshot.settings.temperature,
                        topP: snapshot.settings.topP,
                        reasoningEffort: snapshot.settings.reasoningEffort,
                        maxOutputTokens: snapshot.settings.maxTokens,
                        credentialRef: {
                          kind: 'provider_secret',
                          provider: snapshot.settings.provider,
                        },
                      },
                      configuredMaxTokens: snapshot.settings.maxTokens,
                      externalTools: mcpRuntimeTools.map((tool) => ({ ...tool })),
                      explicitTargets: snapshot.explicitTargets.map((target) => ({ ...target })),
                      correlationId: editPlan.task.correlationId,
                      causationId: editPlan.task.causationId,
                    } satisfies AgentSidecarSubmissionV1)
                  : await client.startRun({
                      version: 1,
                      runId: editPlan.task.runId,
                      workItemId: editPlan.task.id,
                      workflowId: editPlan.task.workflowId ?? undefined,
                      sessionId: editPlan.task.sessionId,
                      objective: runtimeExecution!.prompt,
                      intent: runtimeExecution!.intent,
                      systemInstructions: runtimeExecution!.systemPrompt,
                      compiledContext: runtimeExecution!.context,
                      contextBundle: runtimeContextBundle!,
                      executionPolicy: runtimeExecution!.executionPolicy,
                      toolManifest: buildDomainToolManifest(runtimeExecution!.externalTools),
                      modelPolicy: {
                        provider: snapshot.settings.provider,
                        model: snapshot.settings.model,
                        endpoint: snapshot.settings.endpoint,
                        temperature: snapshot.settings.temperature,
                        topP: snapshot.settings.topP,
                        reasoningEffort: snapshot.settings.reasoningEffort,
                        maxOutputTokens: resolveAgentOutputTokenLimit(
                          snapshot.settings.maxTokens,
                          runtimeExecution!.executionPolicy,
                        ),
                        credentialRef: {
                          kind: 'provider_secret',
                          provider: snapshot.settings.provider,
                        },
                      },
                      ...(runtimeExecution!.outputContract
                        ? {
                            outputContract: {
                              id: runtimeExecution!.outputContract.id,
                              version: runtimeExecution!.outputContract.version,
                              jsonSchema: runtimeExecution!.outputContract.jsonSchema,
                              systemInstruction: runtimeExecution!.outputContract.systemInstruction,
                            },
                          }
                        : {}),
                      correlationId: editPlan.task.correlationId,
                      causationId: editPlan.task.causationId,
                    })
                if (sidecarOwned) {
                  for (const call of result.toolCalls) {
                    if (
                      call.status !== 'completed' ||
                      !call.resultJson ||
                      !['read_document', 'get_current_document'].includes(call.toolName)
                    ) {
                      continue
                    }
                    try {
                      const value = JSON.parse(call.resultJson) as unknown
                      const argumentsValue = JSON.parse(call.argumentsJson) as unknown
                      const documentId =
                        call.toolName === 'read_document' &&
                        typeof argumentsValue === 'object' &&
                        argumentsValue !== null &&
                        'documentId' in argumentsValue &&
                        typeof argumentsValue.documentId === 'string'
                          ? argumentsValue.documentId
                          : snapshot.document.id
                      const provenance = parseReadDocumentProvenance(value, documentId)
                      if (provenance) readableDocuments.set(documentId, provenance)
                    } catch {
                      // Malformed audit payloads must not turn a completed sidecar run into a UI failure.
                    }
                  }
                }
                return result
              })().then((result) => {
                sidecarFinalization = result.sidecarFinalization
                agentRounds = result.rounds
                agentToolCallCount = result.toolCalls.length
                agentDiagnostics = {
                  finishReason: result.finishReason,
                  usage: result.usage,
                }
                recordExecutionResult({ rounds: result.rounds, toolCalls: result.toolCalls })
                return result.output
              })
            : await runAiMarkdownCompletion({
                prompt: buildAiPrompt(snapshot.prompt, mode),
                context: context.text,
                settings: snapshot.settings,
                systemPrompt,
                outputMode: mode === 'edit' ? 'agent-json' : 'markdown',
                signal: abortController.signal,
                onDelta: handleDelta,
              })

      const resolution =
        sidecarOwned && sidecarFinalization
          ? await projectPersistedSidecarFinalization({
              finalization: sidecarFinalization,
              editPlan,
              options,
              assistantMessage: runContext.messages.value[assistantIndex],
              setSummary,
            })
          : await resolveAgentRunOutput({
              output,
              mode,
              editPlan,
              snapshot,
              sources,
              readableDocuments,
              agentRounds,
              agentToolCallCount,
              agentDiagnostics,
              agentIntent,
              cognitiveRun: cognitiveRun as Parameters<
                typeof resolveAgentRunOutput
              >[0]['cognitiveRun'],
              cognitiveSession,
              learningState,
              learningStateBeforeRun,
              learningUserAttempt,
              resumedLearningSession,
              session,
              slashCommand,
              options,
              assistantMessage: runContext.messages.value[assistantIndex],
              hasCognitivePersistence,
              getCognitiveSessionService,
              setSummary,
              runtime: { complete: runtime.complete, cancel: runtime.cancel, fail: runtime.fail },
            })
      const { patchSet, learningResult } = resolution
      cognitiveSession = resolution.cognitiveSession
      learningState = resolution.learningState
      lastRunReport.value = resolution.lastRunReport

      if (acknowledgeSidecarTerminal) {
        try {
          await acknowledgeSidecarTerminal()
        } catch (acknowledgementError) {
          const message = `Agent 结果已保存，但 Rust 终态确认失败：${formatAiErrorMessage(acknowledgementError)}`
          lastRunIssue.value = message
          options.notify.error(message)
        }
      }

      const completionDetail = describeAgentRunCompletion({
        hasPatchSet: Boolean(patchSet),
        slashIntent: slashCommand?.command.intent,
        intent: agentIntent,
        learningResult,
      })
      runtime.complete(completionDetail)
      syncRuntimeMessage()
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError'
      if (cognitiveSession && hasCognitivePersistence()) {
        try {
          const service = await getCognitiveSessionService()
          if (resumedLearningSession && learningStateBeforeRun) {
            await service.waitForUser(
              cognitiveSession.id,
              cognitiveSession.version,
              learningStateBeforeRun,
            )
          } else {
            await service.cancel(cognitiveSession.id, cognitiveSession.version)
          }
        } catch {
          // Preserve the original Runtime failure.
        }
      }
      if (!aborted) runContext.error.value = formatAiErrorMessage(error)
      if (editPlan) {
        editPlan.task.status = aborted ? 'cancelled' : 'failed'
        editPlan.task.currentStep = aborted ? '用户已取消' : '任务失败'
        editPlan.task.completedAt = Date.now()
        editPlan.task.error = aborted ? null : runContext.error.value
        try {
          await options.patches.updateTaskPersistence(editPlan.task)
        } catch (persistenceError) {
          options.notify.error(
            persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
          )
        }
      }
      if (acknowledgeSidecarTerminal) {
        await acknowledgeSidecarTerminal().catch(() => undefined)
      }
      const currentMessage = runContext.messages.value[assistantIndex]
      if (currentMessage) {
        currentMessage.status = aborted ? 'done' : 'error'
        if (agentIntent === 'learning') {
          delete currentMessage.learningResult
          delete currentMessage.learningState
          delete currentMessage.cognitiveProvenance
        }
        if (!aborted) {
          currentMessage.content = runContext.error.value || currentMessage.content
        }
      }
      if (aborted) runtime.cancel('任务已停止')
      else runtime.fail(runContext.error.value || '任务失败')
      syncRuntimeMessage()
    } finally {
      cancelPendingAuthorization('Agent 任务已经结束。')
      finishRun(runKey, runtime)
    }
  }

  function finishRun(runKey: string, runtime: RuntimeController): void {
    const active = activeRuns.get(runKey)
    if (active?.runtime === runtime) {
      active.unsubscribeRuntime?.()
      activeRuns.delete(runKey)
    }
    options.isRunning.value = activeRuns.size > 0
  }

  function stop(conversationId?: string | null): void {
    const requestedId = conversationId ?? selectedConversationId.value
    const active = requestedId ? activeRuns.get(requestedId) : null
    const target = active ?? (activeRuns.size === 1 ? [...activeRuns.values()][0] : null)
    if (target?.runtimeClient && target.runtimeRunId) {
      void target.runtimeClient.cancelRun(target.runtimeRunId).catch(() => undefined)
    } else {
      target?.abortController.abort()
    }
    target?.runtime.cancelPendingAuthorization('用户停止了 Agent。')
  }

  async function restoreWorkerSnapshot(snapshot: {
    activeRuns: Array<{
      runId: string
      workItemId: string
      sessionId: string
      objective: string
    }>
    pendingAuthorizations: Array<{
      authorizationId: string
      runId: string
      question: string
      context: string
      options: string[]
      allowFreeText: boolean
    }>
    pendingTerminals?: Array<{
      runId: string
      workItemId: string
      sessionId: string
      objective: string
      terminalType: 'run.result' | 'run.error'
      recoverable?: boolean
    }>
  }): Promise<void> {
    if (options.services?.runtimeOwner !== 'rust_worker') return
    const {
      TauriAgentRuntimeAdapter,
      AgentRuntimeClient,
      parseReadDocumentProvenance,
      getAgentOutputContract,
    } = await loadAgentRunModules()
    for (const run of snapshot.activeRuns) {
      const runKey = run.sessionId.trim() || run.runId
      if (activeRuns.has(runKey)) continue
      const runtime = createAgentRunRuntimeController(options.createId)
      const pending = snapshot.pendingAuthorizations.find((request) => request.runId === run.runId)
      runtime.restoreActive({
        runId: run.runId,
        goal: run.objective,
        detail: pending ? '等待授权人回答' : '已从 Rust Worker 恢复运行视图',
        authorizationRequest: pending
          ? {
              id: pending.authorizationId,
              question: pending.question,
              context: pending.context,
              options: [...pending.options],
              allowFreeText: pending.allowFreeText,
            }
          : null,
      })
      const task = { id: run.workItemId, runId: run.runId, currentStep: '' } as AgentTask
      const adapter = new TauriAgentRuntimeAdapter({
        dataDirectory: options.services.runtimeDataDirectory?.(),
        requestAuthorizerInput: (request) =>
          runtime.waitForAuthorizerInput(
            {
              id: request.authorizationId,
              question: request.question,
              context: request.context,
              options: request.options,
              allowFreeText: request.allowFreeText,
            },
            task,
          ),
      })
      const client = new AgentRuntimeClient(adapter)
      const unsubscribe = client.subscribeEvents(run.runId, (event) => {
        if (event.type === 'run.progress') {
          const phase = event.payload.phase
          if (
            phase === 'planning' ||
            phase === 'tool_running' ||
            phase === 'tool_completed' ||
            phase === 'finalizing'
          ) {
            runtime.applyProgressUpdate({
              phase,
              detail:
                typeof event.payload.detail === 'string' ? event.payload.detail : 'Agent 正在运行',
            })
          }
        } else if (event.type.startsWith('tool.')) {
          const call = event.payload.toolCall as AgentToolCall | undefined
          if (call) {
            runtime.applyProgressUpdate({
              phase: call.status === 'completed' ? 'tool_completed' : 'tool_running',
              toolName: call.toolName,
              detail: call.error || call.toolName,
              toolCall: call,
            })
          }
        } else if (event.type === 'run.completed') {
          runtime.complete('后台 Agent 运行已完成')
          finishRun(runKey, runtime)
          void adapter.dispose()
        } else if (event.type === 'run.failed') {
          runtime.fail(
            typeof event.payload.error === 'string' ? event.payload.error : '后台 Agent 运行失败',
          )
          finishRun(runKey, runtime)
          void adapter.dispose()
        } else if (event.type === 'run.cancelled') {
          runtime.cancel('后台 Agent 运行已取消')
          finishRun(runKey, runtime)
          void adapter.dispose()
        }
      })
      runtimes.set(runKey, runtime)
      activeRuns.set(runKey, {
        abortController: new AbortController(),
        runtime,
        runtimeClient: client,
        runtimeRunId: run.runId,
        unsubscribeRuntime: unsubscribe,
      })
      activeConversationId.value = runKey
    }
    for (const terminal of snapshot.pendingTerminals ?? []) {
      const runKey = terminal.sessionId.trim() || terminal.runId
      if (activeRuns.has(runKey) || runtimes.has(runKey)) continue
      const runtime = createAgentRunRuntimeController(options.createId)
      runtime.restoreActive({
        runId: terminal.runId,
        goal: terminal.objective,
        detail: '正在从 Rust Core 领取后台终态',
      })
      const adapter = new TauriAgentRuntimeAdapter({
        dataDirectory: options.services.runtimeDataDirectory?.(),
      })
      try {
        const retained = await adapter.getRetainedTerminal(terminal.runId)
        if (!retained) throw new Error(`run_id ${terminal.runId} 没有待领取终态。`)
        if (retained.message.type === 'run.error') throw new Error(retained.message.error.message)
        if (retained.message.type !== 'run.result') {
          throw new Error(`Rust Core 返回了非终态 Worker 消息：${retained.message.type}`)
        }
        const result = retained.message.result
        runtime.recordExecutionResult({ rounds: result.rounds, toolCalls: result.toolCalls })
        const recovery = parseSidecarRunRecoveryContext(retained.recoveryContext)
        if (!recovery) {
          runtime.setSummary('后台 Agent 已完成，业务终态已由 Rust Core 持久化。')
          await adapter.acknowledgeRun(terminal.runId)
          runtime.complete('后台 Agent 已完成，业务终态已由 Rust Core 持久化')
        } else {
          const readableDocuments = new Map(
            recovery.readableDocuments.map((document) => [document.documentId, document]),
          )
          for (const call of result.toolCalls) {
            if (
              call.status !== 'completed' ||
              !call.resultJson ||
              !['read_document', 'get_current_document'].includes(call.toolName)
            ) {
              continue
            }
            try {
              const value = JSON.parse(call.resultJson) as unknown
              const argumentsValue = JSON.parse(call.argumentsJson) as unknown
              const documentId =
                call.toolName === 'read_document' &&
                typeof argumentsValue === 'object' &&
                argumentsValue !== null &&
                'documentId' in argumentsValue &&
                typeof argumentsValue.documentId === 'string'
                  ? argumentsValue.documentId
                  : recovery.snapshot.document.id
              const provenance = parseReadDocumentProvenance(value, documentId)
              if (provenance) readableDocuments.set(documentId, provenance)
            } catch {
              // A malformed audit payload is ignored; Patch validation still requires provenance.
            }
          }
          if (!options.tasks.value.some((task) => task.id === recovery.editPlan.task.id)) {
            options.tasks.value.unshift(recovery.editPlan.task)
          }
          const outputContract = recovery.cognitive
            ? getAgentOutputContract(recovery.cognitive.spec.outputContractId)
            : null
          if (recovery.cognitive && !outputContract) {
            throw new Error(
              `Agent Output Contract ${recovery.cognitive.spec.outputContractId} 不存在。`,
            )
          }
          const resolution = await resolveAgentRunOutput({
            output: result.output,
            mode: recovery.mode,
            editPlan: recovery.editPlan,
            snapshot: {
              ...recovery.snapshot,
              settings: options.settings.value,
            },
            sources: recovery.sources,
            readableDocuments,
            agentRounds: result.rounds,
            agentToolCallCount: result.toolCalls.length,
            agentDiagnostics: {
              finishReason: result.finishReason,
              usage: result.usage,
            },
            agentIntent: recovery.agentIntent,
            cognitiveRun:
              recovery.cognitive && outputContract
                ? {
                    spec: recovery.cognitive.spec,
                    systemPrompt: '',
                    outputContract,
                  }
                : null,
            cognitiveSession: recovery.cognitive?.session ?? null,
            learningState: recovery.cognitive?.learningState ?? null,
            learningStateBeforeRun: recovery.cognitive?.learningStateBeforeRun ?? null,
            learningUserAttempt: recovery.cognitive?.learningUserAttempt ?? null,
            resumedLearningSession: recovery.cognitive?.resumedLearningSession ?? false,
            session: { background: true },
            slashCommand: null,
            options,
            assistantMessage: undefined,
            hasCognitivePersistence,
            getCognitiveSessionService,
            setSummary: runtime.setSummary,
            runtime: { complete: runtime.complete, cancel: runtime.cancel, fail: runtime.fail },
          })
          lastRunReport.value = resolution.lastRunReport
          await adapter.acknowledgeRun(terminal.runId)
          runtime.complete(
            describeAgentRunCompletion({
              hasPatchSet: Boolean(resolution.patchSet),
              intent: recovery.agentIntent,
              learningResult: resolution.learningResult,
            }),
          )
        }
      } catch (error) {
        runtime.fail(formatAiErrorMessage(error))
        if (terminal.terminalType === 'run.error') {
          await adapter.acknowledgeRun(terminal.runId).catch(() => undefined)
        }
      } finally {
        await adapter.dispose()
      }
      runtimes.set(runKey, runtime)
      activeConversationId.value = runKey
    }
    options.isRunning.value = activeRuns.size > 0
  }

  function answerAuthorization(requestId: string, answer: string): boolean {
    for (const active of activeRuns.values()) {
      if (active.runtime.runtimeState.value.authorizationRequest?.id !== requestId) continue
      if (active.runtimeClient && active.runtimeRunId) {
        if (active.runtime.answerAuthorization(requestId, answer)) return true
        active.runtime.settleRestoredAuthorization(requestId)
        void active.runtimeClient
          .steerRun(active.runtimeRunId, {
            kind: 'authorization_response',
            authorizationId: requestId,
            answer,
          })
          .catch((error) => options.notify.error(formatAiErrorMessage(error)))
        return true
      }
      if (active.runtime.answerAuthorization(requestId, answer)) return true
    }
    return false
  }

  function isConversationRunning(conversationId: string | null): boolean {
    return Boolean(conversationId && activeRuns.has(conversationId))
  }

  function runtimeStateFor(conversationId: string | null) {
    return runtimes.get(conversationId ?? '')?.runtimeState.value ?? createIdleAgentRuntimeState()
  }

  function resetRuntime(conversationId?: string | null): void {
    const targetId = conversationId ?? selectedConversationId.value
    if (targetId) runtimes.delete(targetId)
    else fallbackRuntime.reset()
    if (activeConversationId.value === targetId) activeConversationId.value = null
  }

  return {
    run,
    stop,
    answerAuthorization,
    runtimeState,
    lifecycleState,
    runEvents,
    lastTaskId,
    lastRunIssue,
    lastRunReport,
    activeConversationId,
    isConversationRunning,
    runtimeStateFor,
    resetRuntime,
    restoreWorkerSnapshot,
  }
}

function parseSidecarRunRecoveryContext(value: unknown): SidecarRunRecoveryContextV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<SidecarRunRecoveryContextV1>
  if (
    candidate.version !== 1 ||
    candidate.kind !== 'agent_run_output' ||
    candidate.mode !== 'agent' ||
    typeof candidate.agentIntent !== 'string' ||
    !candidate.snapshot ||
    !candidate.editPlan ||
    !Array.isArray(candidate.sources) ||
    !Array.isArray(candidate.readableDocuments)
  ) {
    return null
  }
  return candidate as SidecarRunRecoveryContextV1
}

/**
 * Rust has already persisted this projection. Vue only updates its local
 * review/message state and must not parse model output or write Agent rows.
 */
async function projectPersistedSidecarFinalization(input: {
  finalization: AgentSidecarFinalizationV1
  editPlan: AgentEditPlan | null
  options: UseAgentRunOptions
  assistantMessage: AiConversationMessage | undefined
  setSummary: (summary: string) => void
}): Promise<AgentRunOutputResolution> {
  const { finalization, editPlan, options } = input
  let patchSet: AgentPatchSet | null = null
  if (editPlan) {
    editPlan.task.status = finalization.taskStatus
    editPlan.task.currentStep = finalization.currentStep
    editPlan.task.completedAt = finalization.completedAt
    if (!options.tasks.value.some((task) => task.id === editPlan.task.id)) {
      options.tasks.value.unshift(editPlan.task)
    }
    if (finalization.patches.length > 0) {
      patchSet = {
        taskId: finalization.taskId,
        model: editPlan.task.model,
        createdAt: Date.now(),
        contextSources: finalization.sources.map((source) => ({ ...source })),
        patches: finalization.patches.map((patch) => ({ ...patch, accepted: true })),
      }
      if (options.patches.queueReview) options.patches.queueReview(editPlan.task, patchSet)
      else {
        options.patches.pendingTask.value = editPlan.task
        options.patches.pendingPatchSet.value = patchSet
        options.patches.showModal.value = true
      }
    }
  }
  if (input.assistantMessage) {
    input.assistantMessage.content = finalization.summary
    input.assistantMessage.status = 'done'
  }
  input.setSummary(finalization.summary)
  return {
    patchSet,
    outcome: finalization.outcome,
    summary: finalization.summary,
    researchResult: null,
    reviewResult: null,
    learningResult: null,
    researchCandidates: [],
    cognitiveProvenance: null,
    lastRunReport: finalization.report,
    agentTaskResultPersisted: true,
    cognitiveSession: null,
    learningState: null,
  }
}
