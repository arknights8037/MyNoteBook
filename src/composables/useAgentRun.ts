import { AI_MODE_OPTIONS, type AiChatMode } from '@/models/aiChatMode'
import { appendKnowledgeSources, type KnowledgeSource } from '@/models/knowledgeRetrieval'
import { buildAiPrompt, resolveAiExecutionMode } from '@/services/AiPromptPolicy'
import { normalizeDocumentTitle } from '@/features/documents/documentPresentation'
import { buildAgentRunContext } from './agentRun/agentRunContext'
import {
  createPersistedAgentTask,
  persistAgentRunResult,
} from './agentRun/agentRunPersistence'
import type { AgentRunOutcome } from './agentRun/agentRunResult'
import {
  captureAgentRunSnapshot,
  createAgentEditPlan,
  type AgentEditPlan,
} from './agentRun/agentRunSnapshot'
import type { UseAgentRunOptions } from './agentRun/types'

export type {
  AgentRunDocumentAdapter,
  AgentRunDocumentSnapshot,
  AgentRunPatchWorkflow,
  UseAgentRunOptions,
} from './agentRun/types'

export function useAgentRun(options: UseAgentRunOptions) {
  let abortController: AbortController | null = null

  async function run(): Promise<void> {
    if (options.isRunning.value || !options.prompt.value.trim()) return

    // Capture before the first await so navigation and settings edits cannot retarget this run.
    const snapshot = captureAgentRunSnapshot({
      prompt: options.prompt.value,
      requestedMode: options.mode.value,
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
      { formatAgentRunSummary, resolveAgentRunResult },
    ] = await Promise.all([
      import('@/services/AiMarkdownService'),
      import('@/services/AiSystemPrompt'),
      import('@/services/AgentRuntime'),
      import('@/services/AgentToolExecutor'),
      import('@/services/RustAgentToolService'),
      import('./agentRun/agentRunResult'),
    ])
    const mode = resolveAiExecutionMode(snapshot.requestedMode, snapshot.prompt)
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
      content: snapshot.prompt,
      status: 'done',
    })
    options.messages.value.push(assistantMessage)
    const assistantIndex = options.messages.value.length - 1
    options.prompt.value = ''
    options.isRunning.value = true
    options.error.value = ''
    abortController = new AbortController()

    try {
      const context = await buildAgentRunContext({
        snapshot,
        mode,
        targetBlocks: editPlan?.targetBlocks,
        document: options.document,
      })
      sources = context.sources
      assistantMessage.sources = sources
      const systemPrompt = buildAiSystemPrompt(snapshot.settings.systemPrompt, mode)
      const handleDelta = (delta: string, channel: 'content' | 'reasoning' = 'content') => {
        const currentMessage = options.messages.value[assistantIndex]
        if (!currentMessage) return
        if (channel === 'reasoning') {
          currentMessage.reasoningContent = (currentMessage.reasoningContent ?? '') + delta
        } else if (mode === 'ask') {
          currentMessage.content += delta
        }
      }
      const output =
        mode === 'agent' && editPlan
          ? await runAgentToolLoop({
              taskId: editPlan.task.id,
              prompt: snapshot.prompt,
              context: context.text,
              settings: snapshot.settings,
              systemPrompt,
              signal: abortController?.signal,
              createId: options.createId,
              onDelta: handleDelta,
              onProgress: ({ detail }) => {
                if (!editPlan || editPlan.task.status !== 'running') return
                editPlan.task.currentStep = detail
              },
              executeTool: (request) =>
                executeAgentTool(request, {
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
                }),
              recordToolCall: async (call) => {
                const result = await (await options.patches.getRepository()).recordToolCall(call)
                if (!result.ok) throw new Error(result.error.message)
              },
            }).then((result) => {
              agentRounds = result.rounds
              agentToolCallCount = result.toolCalls.length
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
        await persistAgentRunResult({ task: editPlan.task, patchSet, outcome, patches: options.patches })
      }
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError'
      if (!aborted) options.error.value = error instanceof Error ? error.message : String(error)
      if (editPlan) {
        editPlan.task.status = aborted ? 'cancelled' : 'failed'
        editPlan.task.currentStep = aborted ? '用户已取消' : '任务失败'
        editPlan.task.completedAt = Date.now()
        editPlan.task.error = aborted ? null : options.error.value
        void options.patches.updateTaskPersistence(editPlan.task)
      }
      const currentMessage = options.messages.value[assistantIndex]
      if (currentMessage) {
        currentMessage.status = aborted ? 'done' : 'error'
        if (!aborted) currentMessage.content ||= options.error.value
      }
    } finally {
      options.isRunning.value = false
      abortController = null
    }
  }

  function stop(): void {
    abortController?.abort()
  }

  function fail(error: string): void {
    options.error.value = error
    options.notify.error(error)
  }

  return { run, stop }
}

function getModeLabel(mode: AiChatMode): string {
  return AI_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}
