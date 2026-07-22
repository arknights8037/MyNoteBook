import { ref } from 'vue'

import type { AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import { appendKnowledgeSources, type KnowledgeSource } from '@/models/knowledge/knowledgeRetrieval'
import { buildAiPrompt } from '@/services/ai/AiPromptPolicy'
import { normalizeDocumentTitle } from '@/models/documents/documentPresentation'
import { buildAgentRunContext } from './agentRun/agentRunContext'
import { persistAgentRunResult } from './agentRun/agentRunPersistence'
import type { AgentRunOutcome } from './agentRun/agentRunResult'
import type { AgentCommunicationResult } from '@/services/agent/AgentCommunicationService'
import type { AgentRunContinuation, AgentRunSession, UseAgentRunOptions } from './agentRun/types'
import { compileContextBundle } from '@/models/agent/contextBundle'
import { auditConfiguredModelParameters } from '@/models/agent/providerCapabilities'
import { prepareAgentRunExecution } from '@/services/agent/AgentRunExecution'
import { resolveAgentOutputTokenLimit } from '@/services/agent/AgentToolRegistry'
import type {
  CognitiveResultProvenance,
  LearningTurnResult,
  ResearchCandidateRef,
  ResearchResult,
  ReviewResult,
} from '@/models/cognitive/cognitive'
import { prepareCognitiveRun } from '@/services/cognitive/CognitiveRunService'
import {
  compileLearningStateContext,
  createInitialLearningTurn,
} from '@/services/cognitive/LearningSessionStateService'
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
import {
  describeAgentRunCompletion,
  resolveCognitiveIntentResult,
} from './agentRun/agentRunIntentStrategy'
import { prepareAgentRun } from './agentRun/agentRunPreparation'

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

export function useAgentRun(options: UseAgentRunOptions) {
  let abortController: AbortController | null = null
  let runActive = false
  const runtime = createAgentRunRuntimeController(options.createId)
  const {
    runtimeState,
    waitForAuthorizerInput,
    answerAuthorization,
    cancelPendingAuthorization,
    applyProgressUpdate,
    recordExecutionResult,
    setSummary,
  } = runtime
  const lastTaskId = ref<string | null>(null)
  const lastRunIssue = ref('')
  const lastRunReport = ref<AgentCommunicationResult | null>(null)
  const activeConversationId = ref<string | null>(null)
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
    if (runActive) {
      lastRunIssue.value = 'Agent Runtime 已有任务正在运行。'
      return
    }
    if (!prompt) {
      lastRunIssue.value = 'Agent 请求内容为空。'
      return
    }
    lastTaskId.value = null
    lastRunIssue.value = ''
    lastRunReport.value = null
    const runId = options.createId()
    runActive = true
    abortController = new AbortController()
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
        hasCognitivePersistence: hasCognitivePersistence(),
        getCognitiveSessionService,
      })
    } catch (error) {
      const message = formatAiErrorMessage(error)
      failRun(message)
      runtime.fail(message)
      runActive = false
      abortController = null
      return
    }
    if (!prepared.ok) {
      failRun(prepared.error)
      runtime.fail(prepared.error)
      runActive = false
      abortController = null
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
    activeConversationId.value = conversationId || null

    const [
      { runAiMarkdownCompletion },
      { buildAiSystemPrompt },
      { runAgentToolLoop },
      { executeAgentTool, prepareReadDocumentObservation },
      { executeRustAgentTool },
      { loadEnabledSkillPrompt },
      { formatAgentRunSummary, resolveAgentRunResult },
    ] = await Promise.all([
      import('@/services/ai/AiMarkdownService'),
      import('@/services/ai/AiSystemPrompt'),
      import('@/services/agent/AgentRuntime'),
      import('@/services/agent/AgentToolExecutor'),
      import('@/services/agent/RustAgentToolService'),
      import('@/services/integrations/SkillService'),
      import('./agentRun/agentRunResult'),
    ])
    let sources: KnowledgeSource[] = []
    let agentRounds = 0
    let agentToolCallCount = 0
    let agentDiagnostics: Pick<AgentRuntimeResult, 'finishReason' | 'usage'> = {}
    let researchResult: ResearchResult | null = null
    let reviewResult: ReviewResult | null = null
    let learningResult: LearningTurnResult | null = null
    let agentTaskResultPersisted = false
    let researchCandidates: ResearchCandidateRef[] = []
    const workspaceDocumentIds = resolveWorkspaceDocumentIds(
      snapshot.document.documents,
      snapshot.workspace?.rootDocumentIds ?? [],
    )
    workspaceDocumentIds.add(snapshot.document.id)
    const discoveredDocumentIds = new Set(workspaceDocumentIds)
    const readableDocuments = new Map<
      string,
      {
        documentId: string
        documentTitle: string
        expectedVersion: number
        blocks: Array<{ id: string; type: string; text: string; index: number }>
      }
    >()
    const { parseReadDocumentProvenance, validateDocumentEditProvenance } =
      await import('@/services/agent/AgentEditProposalGuard')
    const taskApprovedMcpServerIds = new Set<string>()

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
    runtime.beginExecution(
      mode === 'agent' ? '正在准备 Agent 任务' : '正在准备文档上下文',
    )
    const syncRuntimeMessage = (): void => {
      const message = runContext.messages.value[assistantIndex]
      if (!message || message.role !== 'assistant') return
      message.agentRuntime = createPersistableRuntimeSnapshot(runtimeState.value)
    }

    try {
      if (continuation) {
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
      const context = await buildAgentRunContext({
        snapshot,
        mode,
        targetBlocks: editPlan?.targetBlocks,
        document: options.document,
      })
      const conversationContext = compileConversationContinuationContext(priorConversationMessages)
      if (conversationContext) {
        context.text += `\n\n${conversationContext}`
      }
      sources = context.sources
      assistantMessage.sources = sources
      const skillPrompt = await loadEnabledSkillPrompt().catch(() => ({
        catalog: '',
        instructions: '',
        skills: [],
      }))
      const effectiveKnowledge = options.services?.getKnowledgeRepository
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
      const approvedReferenceKnowledge = options.services?.getKnowledgeRepository
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
              return result.ok ? selectRelevantApprovedKnowledge(result.value, snapshot.prompt) : []
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
      if (editPlan) {
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
      }
      const mcpRuntimeTools =
        mode === 'agent' && options.services?.mcpClient
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
      runtime.beginExecution(
        mode === 'agent'
          ? '正在规划任务'
          : mode === 'edit'
            ? '正在生成修改提案'
            : '正在生成回答',
      )
      const output =
        agentIntent === 'learning' &&
        !resumedLearningSession &&
        learningState?.attempts.length === 0
          ? JSON.stringify(createInitialLearningTurn(learningState.topic))
          : mode === 'agent' && editPlan
            ? await runAgentToolLoop({
                taskId: editPlan.task.id,
                ...runtimeExecution!,
                settings: snapshot.settings,
                signal: abortController?.signal,
                createId: options.createId,
                validateDocumentEditProposal: (proposal) =>
                  validateDocumentEditProvenance(proposal, [...readableDocuments.values()]),
                onDelta: handleDelta,
                onProgress: (update) => {
                  if (!editPlan || editPlan.task.status !== 'running') return
                  editPlan.task.currentStep = update.detail
                  applyProgressUpdate(update)
                  syncRuntimeMessage()
                },
                executeTool: async (request) => {
                  const externalTool = mcpRuntimeTools.find(
                    (tool) => tool.runtimeName === request.name,
                  )
                  if (externalTool) {
                    if (
                      externalTool.requiresConfirmation &&
                      !taskApprovedMcpServerIds.has(externalTool.serverId)
                    ) {
                      const answer = await waitForAuthorizerInput(
                        {
                          question: `允许调用 MCP 工具“${externalTool.title || externalTool.name}”吗？`,
                          context: `外部服务：${externalTool.serverName}\n选择“允许本次任务”后，该服务在当前 Agent 任务中的后续调用将自动批准。\n参数：${JSON.stringify(request.arguments).slice(0, 1_000)}`,
                          options: ['允许本次任务', '仅允许本次调用', '拒绝'],
                          allowFreeText: false,
                        },
                        editPlan.task,
                      )
                      if (answer === '允许本次任务') {
                        taskApprovedMcpServerIds.add(externalTool.serverId)
                      } else if (answer !== '仅允许本次调用') {
                        return { ok: false, error: '授权人拒绝了 MCP 工具调用。' }
                      }
                    }
                    try {
                      const mcpClient = options.services?.mcpClient
                      if (!mcpClient) throw new Error('当前运行环境未提供 MCP Client。')
                      return {
                        ok: true,
                        value: await mcpClient.callTool(
                          externalTool.serverId,
                          externalTool.name,
                          request.arguments,
                          { callId: request.callId, signal: request.signal },
                        ),
                      }
                    } catch (mcpError) {
                      return {
                        ok: false,
                        error: mcpError instanceof Error ? mcpError.message : String(mcpError),
                      }
                    }
                  }
                  return executeAgentTool(request, {
                    currentDocument: {
                      id: snapshot.document.id,
                      title: normalizeDocumentTitle(snapshot.document.title),
                      revision: snapshot.document.revision,
                      text: snapshot.document.text,
                      markdown: snapshot.document.markdown || snapshot.document.text,
                      blocks: snapshot.document.blocks,
                    },
                    selectedBlocks: editPlan.usesSelection ? editPlan.targetBlocks : [],
                    workspaceRootIds: snapshot.workspace?.rootDocumentIds ?? [],
                    workspaceDocumentIds: [...workspaceDocumentIds],
                    onDocumentsDiscovered: (documentIds) => {
                      for (const documentId of documentIds) discoveredDocumentIds.add(documentId)
                    },
                    canReadDocument: (documentId) => discoveredDocumentIds.has(documentId),
                    searchDocuments: options.document.searchDocuments,
                    readDocument: options.document.readDocument,
                    listMindMaps: async () => {
                      const provider = options.services?.getMindMapService
                      if (!provider) throw new Error('当前运行环境未提供思维导图服务。')
                      const result = await (await provider()).list()
                      if (!result.ok) throw new Error(result.error.message)
                      return result.value
                    },
                    readMindMap: async (mindMapId, query) => {
                      const provider = options.services?.getMindMapService
                      if (!provider) throw new Error('当前运行环境未提供思维导图服务。')
                      const result = await (await provider()).readSubtree(mindMapId, query)
                      if (!result.ok) {
                        if (result.error.code === 'not-found') return null
                        throw new Error(result.error.message)
                      }
                      return result.value
                    },
                    onDocumentRead: async (documentId, toolResult) => {
                      const provenance = parseReadDocumentProvenance(toolResult, documentId)
                      if (provenance) {
                        const existing = readableDocuments.get(documentId)
                        if (existing && existing.expectedVersion === provenance.expectedVersion) {
                          const blocks = new Map(existing.blocks.map((block) => [block.id, block]))
                          for (const block of provenance.blocks) blocks.set(block.id, block)
                          readableDocuments.set(documentId, {
                            ...existing,
                            blocks: [...blocks.values()].sort(
                              (left, right) => left.index - right.index,
                            ),
                          })
                        } else {
                          readableDocuments.set(documentId, provenance)
                        }
                        return
                      }
                      const [document, blocks] = await Promise.all([
                        options.document.readDocument(documentId),
                        options.document.listDocumentBlocks(documentId),
                      ])
                      if (!document) return
                      readableDocuments.set(documentId, {
                        documentId,
                        documentTitle: normalizeDocumentTitle(document.title),
                        expectedVersion: document.revision,
                        blocks: blocks.map((block) => ({
                          id: block.id,
                          type: block.type,
                          text: block.plainText,
                          index: block.index,
                        })),
                      })
                    },
                    executeNativeTool: executeRustAgentTool,
                    requestAuthorizerInput: (request) =>
                      waitForAuthorizerInput(request, editPlan.task),
                    createAutomationDraft: async (input) => {
                      const provider = options.services?.getAgentResourceDraftService
                      if (!provider) throw new Error('当前运行环境未提供 Agent 资源草稿服务。')
                      const service = await provider()
                      return service.createAutomationDraft(input)
                    },
                    createSkillDraft: async (input) => {
                      const provider = options.services?.getAgentResourceDraftService
                      if (!provider) throw new Error('当前运行环境未提供 Agent 资源草稿服务。')
                      const service = await provider()
                      return service.createSkillDraft(input)
                    },
                    createMcpServerDraft: async (input) => {
                      const provider = options.services?.getAgentResourceDraftService
                      if (!provider) throw new Error('当前运行环境未提供 Agent 资源草稿服务。')
                      const service = await provider()
                      return service.createMcpServerDraft(input)
                    },
                  })
                },
                recordToolCall: async (call) => {
                  const result = await (await options.patches.getRepository()).recordToolCall(call)
                  if (!result.ok) throw new Error(result.error.message)
                },
              }).then((result) => {
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

      let patchSet = null
      let outcome: AgentRunOutcome = 'proposal'
      let summary = ''
      if ((mode === 'edit' || mode === 'agent') && editPlan) {
        if (cognitiveRun) {
          const structuredResult = cognitiveRun.outputContract.validate(JSON.parse(output))
          const resolved = await resolveCognitiveIntentResult(agentIntent, {
            structuredResult,
            learningState,
            learningUserAttempt,
            document: {
              readDocument: options.document.readDocument,
              listDocumentBlocks: options.document.listDocumentBlocks,
            },
            createId: options.createId,
          })
          researchResult = resolved.researchResult
          reviewResult = resolved.reviewResult
          learningResult = resolved.learningResult
          learningState = resolved.learningState ?? learningState
          summary = resolved.summary
          outcome = 'no_change'
        } else {
          const result = await resolveAgentRunResult({
            output,
            mode,
            task: editPlan.task,
            snapshot,
            expectedRevision: editPlan.expectedRevision,
            targetBlocks: editPlan.targetBlocks,
            readableDocuments: [...readableDocuments.values()],
            sources,
            usesSelection: editPlan.usesSelection,
            foundTargetScope: editPlan.foundTargetScope,
            replaceBlocksByRegex: options.replaceBlocksByRegex,
            createId: options.createId,
          })
          patchSet = result.patchSet
          outcome = result.outcome
          summary = result.summary
        }
        lastRunReport.value = {
          version: 1,
          outcome,
          summary:
            summary ||
            (outcome === 'proposal'
              ? '已生成待确认修改提案。'
              : outcome === 'blocked'
                ? '现有信息不足，未生成修改。'
                : '检查完成，无需修改。'),
          patchCount: patchSet?.patches.length ?? 0,
          targetDocumentIds: Array.from(
            new Set(patchSet?.patches.map((patch) => patch.documentId) ?? []),
          ),
          ...(researchResult
            ? { cognitive: { mode: 'research' as const, result: researchResult } }
            : reviewResult
              ? { cognitive: { mode: 'review' as const, result: reviewResult } }
              : learningResult
                ? {
                    cognitive: {
                      mode: 'learning' as const,
                      result: learningResult,
                      state: learningState,
                    },
                  }
                : {}),
          ...agentDiagnostics,
        }
      }

      const currentMessage = runContext.messages.value[assistantIndex]
      let cognitiveProvenance: CognitiveResultProvenance | null = null
      if (
        (researchResult || reviewResult || learningResult) &&
        cognitiveRun &&
        cognitiveSession &&
        editPlan
      ) {
        cognitiveProvenance = {
          sessionId: cognitiveSession.id,
          runId: editPlan.task.id,
          modeId: cognitiveRun.spec.modeId,
          modeVersion: cognitiveRun.spec.modeVersion,
          templateId: cognitiveRun.spec.templateId,
          templateVersion: cognitiveRun.spec.templateVersion,
          outputContractId: cognitiveRun.spec.outputContractId,
          createdAt: Date.now(),
        }
        if (researchResult && options.services?.getResearchCandidateService) {
          const created = await (
            await options.services.getResearchCandidateService()
          ).createFromResult({
            result: researchResult,
            provenance: cognitiveProvenance,
          })
          if (!created.ok) throw new Error(created.error.message)
          researchCandidates = created.value
        }
      }
      if (currentMessage) {
        currentMessage.content =
          mode === 'ask' && sources.length > 0
            ? appendKnowledgeSources(output, sources)
            : mode === 'edit' || mode === 'agent'
              ? formatAgentRunSummary({
                  summary,
                  outcome,
                  patchCount: patchSet?.patches.length ?? 0,
                  rounds: agentRounds,
                  toolCallCount: mode === 'agent' ? agentToolCallCount : 0,
                })
              : currentMessage.content
        currentMessage.status = 'done'
        setSummary(
          summary.trim() ||
            (outcome === 'proposal'
              ? '已生成待确认的修改提案。'
              : outcome === 'blocked'
                ? '现有信息不足，任务暂时无法继续。'
                : '任务已完成。'),
        )
        if (researchResult && cognitiveProvenance) {
          currentMessage.researchResult = researchResult
          currentMessage.cognitiveProvenance = cognitiveProvenance
          currentMessage.researchCandidates = researchCandidates
        }
        if (reviewResult && cognitiveProvenance) {
          currentMessage.reviewResult = reviewResult
          currentMessage.cognitiveProvenance = cognitiveProvenance
        }
        if (learningResult && learningState && cognitiveProvenance) {
          currentMessage.learningResult = learningResult
          currentMessage.learningState = learningState
          currentMessage.cognitiveProvenance = cognitiveProvenance
        }
      }
      const cognitiveResult = researchResult ?? reviewResult ?? learningResult
      if (learningResult && editPlan) {
        await persistAgentRunResult({
          task: editPlan.task,
          patchSet,
          outcome,
          patches: options.patches,
        })
        agentTaskResultPersisted = true
      }
      if (cognitiveResult && cognitiveSession) {
        if (agentIntent === 'learning' && learningResult && learningState) {
          if (hasCognitivePersistence()) {
            const service = await getCognitiveSessionService()
            const updated =
              learningResult.phase === 'waiting_user'
                ? await service.waitForUser(
                    cognitiveSession.id,
                    cognitiveSession.version,
                    learningState,
                  )
                : await service.complete(
                    cognitiveSession.id,
                    cognitiveSession.version,
                    learningState,
                  )
            if (!updated.ok) throw new Error(updated.error.message)
            cognitiveSession = updated.value
          } else {
            cognitiveSession = {
              ...cognitiveSession,
              state: learningState,
              status: learningResult.phase === 'waiting_user' ? 'waiting_user' : 'completed',
              version: cognitiveSession.version + 1,
              updatedAt: Date.now(),
            }
          }
        } else if (hasCognitivePersistence()) {
          const completed = await (
            await getCognitiveSessionService()
          ).complete(cognitiveSession.id, cognitiveSession.version, {
            runId: editPlan?.task.id,
            phase: 'completed',
            result: cognitiveResult,
            candidateIds: researchCandidates.map((candidate) => candidate.candidateId),
          })
          if (!completed.ok) throw new Error(completed.error.message)
          cognitiveSession = completed.value
        }
      }
      if (editPlan && !agentTaskResultPersisted) {
        const patchTargetDocumentId = patchSet?.patches.find(
          (patch) => patch.operation !== 'create_document' && patch.operation !== 'create_group',
        )?.documentId
        await persistAgentRunResult({
          task: editPlan.task,
          patchSet,
          outcome,
          patches: options.patches,
        })
        if (
          !session?.background &&
          patchTargetDocumentId &&
          patchTargetDocumentId !== snapshot.document.id
        ) {
          await options.document.openDocumentForReview(patchTargetDocumentId)
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
      options.isRunning.value = false
      runActive = false
      abortController = null
    }
  }

  function stop(): void {
    cancelPendingAuthorization('用户停止了 Agent。')
    abortController?.abort()
  }

  function resetRuntime(): void {
    runtime.reset()
    activeConversationId.value = null
  }

  return {
    run,
    stop,
    answerAuthorization,
    runtimeState,
    lifecycleState: runtime.lifecycleState,
    runEvents: runtime.runEvents,
    lastTaskId,
    lastRunIssue,
    lastRunReport,
    activeConversationId,
    resetRuntime,
  }
}
