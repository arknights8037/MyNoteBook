import { ref } from 'vue'

import { AI_MODE_OPTIONS, type AiChatMode } from '@/models/aiChatMode'
import {
  createIdleAgentRuntimeState,
  type AgentAuthorizationRequest,
  type AgentRuntimeViewState,
} from '@/models/agentRuntime'
import { resolveAgentSlashCommand } from '@/models/agentSlashCommand'
import type { AgentProgressUpdate } from '@/services/AgentRuntime'
import { appendKnowledgeSources, type KnowledgeSource } from '@/models/knowledgeRetrieval'
import {
  buildAiPrompt,
  inferAiAgentIntent,
  resolveAiExecutionMode,
} from '@/services/AiPromptPolicy'
import { normalizeDocumentTitle } from '@/features/documents/documentPresentation'
import { buildAgentRunContext } from './agentRun/agentRunContext'
import { createPersistedAgentTask, persistAgentRunResult } from './agentRun/agentRunPersistence'
import type { AgentRunOutcome } from './agentRun/agentRunResult'
import {
  captureAgentRunSnapshot,
  createAgentEditPlan,
  type AgentEditPlan,
} from './agentRun/agentRunSnapshot'
import type { UseAgentRunOptions } from './agentRun/types'
import { compileContextBundle } from '@/models/contextBundle'
import { auditConfiguredModelParameters } from '@/models/providerCapabilities'

export type {
  AgentRunDocumentAdapter,
  AgentRunDocumentSnapshot,
  AgentRunPatchWorkflow,
  UseAgentRunOptions,
} from './agentRun/types'

export function useAgentRun(options: UseAgentRunOptions) {
  let abortController: AbortController | null = null
  let pendingAuthorization: {
    request: AgentAuthorizationRequest
    resolve: (answer: string) => void
    reject: (error: Error) => void
  } | null = null
  const runtimeState = ref<AgentRuntimeViewState>(createIdleAgentRuntimeState())

  async function run(): Promise<void> {
    if (options.isRunning.value || !options.prompt.value.trim()) return

    const originalPrompt = options.prompt.value.trim()
    const slashCommand = resolveAgentSlashCommand(originalPrompt)
    if (slashCommand) options.mode.value = slashCommand.command.mode

    // Capture before the first await so navigation and settings edits cannot retarget this run.
    const snapshot = captureAgentRunSnapshot({
      prompt: slashCommand?.prompt ?? originalPrompt,
      requestedMode: slashCommand?.command.mode ?? options.mode.value,
      settings: options.settings.value,
      document: options.document.captureSnapshot(),
    })
    if (!(await options.ensureSecretLoaded())) {
      fail('密钥库在 3 秒内未就绪，请稍后重试或在 AI 设置中重新填写 API Key。')
      return
    }
    // Secret loading may populate the active key; all non-secret run settings stay frozen.
    snapshot.settings.apiKey ||= options.settings.value.apiKey
    if (!snapshot.settings.model.trim()) {
      fail('请先在 AI 设置中获取或填写模型。')
      return
    }

    const [
      { runAiMarkdownCompletion },
      { buildAiSystemPrompt },
      { runAgentToolLoop },
      { executeAgentTool },
      { executeRustAgentTool },
      { loadEnabledSkillPrompt },
      { formatAgentRunSummary, resolveAgentRunResult },
    ] = await Promise.all([
      import('@/services/AiMarkdownService'),
      import('@/services/AiSystemPrompt'),
      import('@/services/AgentRuntime'),
      import('@/services/AgentToolExecutor'),
      import('@/services/RustAgentToolService'),
      import('@/services/SkillService'),
      import('./agentRun/agentRunResult'),
    ])
    const mode = resolveAiExecutionMode(snapshot.requestedMode, snapshot.prompt)
    const agentIntent = slashCommand?.command.intent ?? inferAiAgentIntent(snapshot.prompt)
    let editPlan: AgentEditPlan | null = null
    let sources: KnowledgeSource[] = []
    let agentRounds = 0
    let agentToolCallCount = 0

    if (snapshot.requestedMode === 'auto') {
      options.notify.success(`Auto 已选择 ${getModeLabel(mode)} 处理本次任务`)
    }

    if (mode === 'edit' || mode === 'agent') {
      const flushResult = await options.document.flushBeforeEdit()
      if (!flushResult.ok) {
        fail('当前文档保存失败，暂不能发起 Agent 修改。')
        return
      }
      snapshot.document.revision = flushResult.revision ?? snapshot.document.revision
      editPlan = createAgentEditPlan({ snapshot, mode, createId: options.createId })
      if (!editPlan) {
        fail('当前文档还没有可修改的块或版本信息。')
        return
      }
      const persistenceError = await createPersistedAgentTask(editPlan.task, options)
      if (persistenceError) {
        fail(persistenceError)
        return
      }
    }

    const assistantMessage = {
      id: options.createId(),
      role: 'assistant' as const,
      mode,
      content: '',
      reasoningContent: '',
      sources: [],
      status: 'streaming' as const,
    }
    options.messages.value.push({
      id: options.createId(),
      role: 'user',
      mode,
      content: slashCommand?.originalPrompt ?? snapshot.prompt,
      status: 'done',
    })
    options.messages.value.push(assistantMessage)
    const assistantIndex = options.messages.value.length - 1
    options.prompt.value = ''
    options.isRunning.value = true
    options.error.value = ''
    abortController = new AbortController()
    runtimeState.value = {
      status: 'running',
      phase: 'preparing',
      detail: '正在准备文档上下文',
      startedAt: Date.now(),
      completedAt: null,
      rounds: 0,
      toolCalls: [],
      authorizationRequest: null,
    }

    try {
      const context = await buildAgentRunContext({
        snapshot,
        mode,
        targetBlocks: editPlan?.targetBlocks,
        document: options.document,
      })
      sources = context.sources
      assistantMessage.sources = sources
      const skillPrompt = await loadEnabledSkillPrompt().catch(() => ({
        catalog: '',
        instructions: '',
        skills: [],
      }))
      const effectiveKnowledge = Reflect.has(globalThis, '__TAURI_INTERNALS__')
        ? await import('@/infrastructure/database/knowledgeRepositoryFactory')
            .then(async ({ createKnowledgeRepository }) => {
              const repository = await createKnowledgeRepository()
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
      if (editPlan) {
        const bundleSources = sources.some(
          (source) => source.documentId === snapshot.document.id,
        )
          ? sources
          : [
              {
                id: 'S1',
                documentId: snapshot.document.id,
                documentTitle: normalizeDocumentTitle(snapshot.document.title),
                contentSnippet: snapshot.document.text,
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
              maxOutputTokens: Math.min(
                snapshot.settings.maxTokens,
                editPlan.task.executionPolicy.tokenBudget,
              ),
              toolCalling: mode === 'agent',
            },
          },
          ignoredParameters: Array.from(new Set([
            ...parameterAudit.ignored,
            ...(mode === 'agent' && snapshot.settings.reasoningEffort !== 'auto'
              ? ['reasoningEffort']
              : []),
          ])),
          skillVersions: skillPrompt.skills ?? [],
        })
        if (!savedBundle.ok) throw new Error(savedBundle.error.message)
        editPlan.task.contextBundleId = contextBundle.id
      }
      const mcpRuntimeTools =
        mode === 'agent'
          ? await import('@/services/McpService')
              .then(async ({ listMcpTools }) => {
                const { createMcpRuntimeTools } = await import('@/models/mcp')
                return createMcpRuntimeTools(await listMcpTools())
              })
              .catch(() => [])
          : []
      const systemPrompt = buildAiSystemPrompt(
        snapshot.settings.systemPrompt,
        mode,
        skillPrompt,
        slashCommand?.command.systemInstruction,
      )
      const handleDelta = (delta: string, channel: 'content' | 'reasoning' = 'content') => {
        const currentMessage = options.messages.value[assistantIndex]
        if (!currentMessage) return
        if (channel === 'reasoning') {
          currentMessage.reasoningContent = (currentMessage.reasoningContent ?? '') + delta
        } else if (mode === 'ask') {
          currentMessage.content += delta
        }
      }
      runtimeState.value.phase = 'planning'
      runtimeState.value.detail =
        mode === 'agent' ? '正在规划任务' : mode === 'edit' ? '正在生成修改提案' : '正在生成回答'
      const output =
        mode === 'agent' && editPlan
          ? await runAgentToolLoop({
              taskId: editPlan.task.id,
              prompt: snapshot.prompt,
              context: context.text,
              settings: snapshot.settings,
              systemPrompt,
              intent: agentIntent,
              externalTools: mcpRuntimeTools,
              executionPolicy: editPlan.task.executionPolicy,
              signal: abortController?.signal,
              createId: options.createId,
              onDelta: handleDelta,
              onProgress: (update) => {
                if (!editPlan || editPlan.task.status !== 'running') return
                editPlan.task.currentStep = update.detail
                applyProgressUpdate(update)
              },
              executeTool: async (request) => {
                const externalTool = mcpRuntimeTools.find(
                  (tool) => tool.runtimeName === request.name,
                )
                if (externalTool) {
                  if (externalTool.requiresConfirmation) {
                    const answer = await waitForAuthorizerInput(
                      {
                        question: `允许调用 MCP 工具“${externalTool.title || externalTool.name}”吗？`,
                        context: `外部服务：${externalTool.serverName}\n参数：${JSON.stringify(request.arguments).slice(0, 1_000)}`,
                        options: ['允许本次调用', '拒绝'],
                        allowFreeText: false,
                      },
                      editPlan,
                    )
                    if (answer !== '允许本次调用') {
                      return { ok: false, error: '授权人拒绝了 MCP 工具调用。' }
                    }
                  }
                  try {
                    const { callMcpTool } = await import('@/services/McpService')
                    return {
                      ok: true,
                      value: await callMcpTool(
                        externalTool.serverId,
                        externalTool.name,
                        request.arguments,
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
                    blocks: snapshot.document.blocks,
                  },
                  selectedBlocks: editPlan.usesSelection ? editPlan.targetBlocks : [],
                  searchDocuments: options.document.searchDocuments,
                  readDocument: options.document.readDocument,
                  executeNativeTool: executeRustAgentTool,
                  requestAuthorizerInput: (request) => waitForAuthorizerInput(request, editPlan),
                  createAutomationDraft: async (input) => {
                    const { createAgentResourceDraftService } =
                      await import('@/app/composition/agentResourceDraftServiceFactory')
                    const service = await createAgentResourceDraftService(options.createId)
                    return service.createAutomationDraft(input)
                  },
                  createSkillDraft: async (input) => {
                    const { createAgentResourceDraftService } =
                      await import('@/app/composition/agentResourceDraftServiceFactory')
                    const service = await createAgentResourceDraftService(options.createId)
                    return service.createSkillDraft(input)
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
              runtimeState.value.rounds = result.rounds
              runtimeState.value.toolCalls = result.toolCalls
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
        const result = resolveAgentRunResult({
          output,
          mode,
          task: editPlan.task,
          snapshot,
          expectedRevision: editPlan.expectedRevision,
          targetBlocks: editPlan.targetBlocks,
          sources,
          usesSelection: editPlan.usesSelection,
          foundTargetScope: editPlan.foundTargetScope,
          createId: options.createId,
        })
        patchSet = result.patchSet
        outcome = result.outcome
        summary = result.summary
      }

      const currentMessage = options.messages.value[assistantIndex]
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
      }
      if (editPlan) {
        await persistAgentRunResult({
          task: editPlan.task,
          patchSet,
          outcome,
          patches: options.patches,
        })
      }
      runtimeState.value.status = 'completed'
      runtimeState.value.phase = 'completed'
      runtimeState.value.detail = patchSet
        ? '修改提案已准备，等待确认'
        : slashCommand?.command.intent === 'plan'
          ? '计划已完成'
          : slashCommand?.command.intent === 'research'
            ? '调研已完成'
            : '任务已完成'
      runtimeState.value.completedAt = Date.now()
      runtimeState.value.authorizationRequest = null
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError'
      if (!aborted) options.error.value = error instanceof Error ? error.message : String(error)
      if (editPlan) {
        editPlan.task.status = aborted ? 'cancelled' : 'failed'
        editPlan.task.currentStep = aborted ? '用户已取消' : '任务失败'
        editPlan.task.completedAt = Date.now()
        editPlan.task.error = aborted ? null : options.error.value
        try {
          await options.patches.updateTaskPersistence(editPlan.task)
        } catch (persistenceError) {
          options.notify.error(
            persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
          )
        }
      }
      const currentMessage = options.messages.value[assistantIndex]
      if (currentMessage) {
        currentMessage.status = aborted ? 'done' : 'error'
        if (!aborted) currentMessage.content ||= options.error.value
      }
      runtimeState.value.status = aborted ? 'cancelled' : 'failed'
      runtimeState.value.phase = aborted ? 'cancelled' : 'failed'
      runtimeState.value.detail = aborted ? '任务已停止' : options.error.value || '任务失败'
      runtimeState.value.completedAt = Date.now()
      runtimeState.value.authorizationRequest = null
    } finally {
      cancelPendingAuthorization('Agent 任务已经结束。')
      options.isRunning.value = false
      abortController = null
    }
  }

  function stop(): void {
    cancelPendingAuthorization('用户停止了 Agent。')
    abortController?.abort()
  }

  function waitForAuthorizerInput(
    request: Omit<AgentAuthorizationRequest, 'id'>,
    editPlan: AgentEditPlan,
  ): Promise<string> {
    cancelPendingAuthorization('Agent 提出了新的授权问题。')
    const authorizationRequest: AgentAuthorizationRequest = {
      ...request,
      id: options.createId(),
      options: request.options.slice(0, 5),
    }
    editPlan.task.currentStep = '等待授权人回答'
    runtimeState.value.status = 'waiting_authorizer'
    runtimeState.value.phase = 'waiting_authorizer'
    runtimeState.value.detail = '等待授权人回答'
    runtimeState.value.authorizationRequest = authorizationRequest
    return new Promise<string>((resolve, reject) => {
      pendingAuthorization = { request: authorizationRequest, resolve, reject }
    })
  }

  function answerAuthorization(requestId: string, answer: string): boolean {
    const pending = pendingAuthorization
    const normalized = answer.trim()
    if (!pending || pending.request.id !== requestId || !normalized) return false
    if (
      !pending.request.allowFreeText &&
      pending.request.options.length > 0 &&
      !pending.request.options.includes(normalized)
    ) {
      return false
    }
    pendingAuthorization = null
    runtimeState.value.status = 'running'
    runtimeState.value.phase = 'tool_running'
    runtimeState.value.detail = '已收到授权人回答，继续执行'
    runtimeState.value.authorizationRequest = null
    pending.resolve(normalized)
    return true
  }

  function cancelPendingAuthorization(message: string): void {
    if (!pendingAuthorization) return
    const pending = pendingAuthorization
    pendingAuthorization = null
    runtimeState.value.authorizationRequest = null
    pending.reject(Object.assign(new Error(message), { name: 'AbortError' }))
  }

  function fail(error: string): void {
    options.error.value = error
    options.notify.error(error)
  }

  function applyProgressUpdate(update: AgentProgressUpdate): void {
    runtimeState.value.phase = update.phase
    runtimeState.value.detail = update.detail
    if (!update.toolCall) return

    const index = runtimeState.value.toolCalls.findIndex((call) => call.id === update.toolCall?.id)
    if (index >= 0) runtimeState.value.toolCalls[index] = update.toolCall
    else runtimeState.value.toolCalls.push(update.toolCall)
  }

  function resetRuntime(): void {
    runtimeState.value = createIdleAgentRuntimeState()
  }

  return { run, stop, answerAuthorization, runtimeState, resetRuntime }
}

function projectKnowledgeForBundle(object: {
  id: string
  objectType: string
  title: string
  version: number
  documentId: string | null
  blockId: string | null
  sourceRevision: number | null
  authorityLevel: string
}) {
  return {
    id: object.id,
    objectType: object.objectType,
    title: object.title,
    version: object.version,
    documentId: object.documentId,
    blockId: object.blockId,
    sourceRevision: object.sourceRevision,
    authorityLevel: object.authorityLevel,
  }
}

function getModeLabel(mode: AiChatMode): string {
  return AI_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}
