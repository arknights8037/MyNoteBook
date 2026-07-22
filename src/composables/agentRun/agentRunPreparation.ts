import type { AiConversationMessage } from '@/composables/useAiConversation'
import { createPersistedAgentTask } from '@/composables/agentRun/agentRunPersistence'
import {
  captureAgentRunSnapshot,
  createAgentEditPlan,
  type AgentEditPlan,
} from '@/composables/agentRun/agentRunSnapshot'
import {
  hydrateCanonicalDocumentSnapshot,
  hydrateExplicitDocumentTargets,
} from '@/composables/agentRun/agentRunTargets'
import type {
  AgentRunContinuation,
  AgentRunSession,
  AgentRunSnapshot,
  UseAgentRunOptions,
} from '@/composables/agentRun/types'
import { resolveAgentSlashCommand } from '@/models/agent/agentSlashCommand'
import type {
  CognitiveSession,
  LearningSessionState,
} from '@/models/cognitive/cognitive'
import { inferAiAgentIntent, resolveAiExecutionMode } from '@/services/ai/AiPromptPolicy'
import type { CognitiveSessionService } from '@/services/cognitive/CognitiveSessionService'
import {
  createLearningSessionState,
  parseLearningSessionState,
} from '@/services/cognitive/LearningSessionStateService'
import { getModeLabel, restrictToolsForIntent } from '@/composables/agentRun/agentRunSupport'

export interface PreparedAgentRun {
  snapshot: AgentRunSnapshot
  slashCommand: ReturnType<typeof resolveAgentSlashCommand>
  priorConversationMessages: AiConversationMessage[]
  conversationId: string
  mode: 'ask' | 'edit' | 'agent'
  agentIntent: ReturnType<typeof inferAiAgentIntent>
  editPlan: AgentEditPlan | null
  cognitiveSession: CognitiveSession | null
  learningState: LearningSessionState | null
  learningStateBeforeRun: LearningSessionState | null
  learningUserAttempt: string | null
  resumedLearningSession: boolean
}

export type PrepareAgentRunResult =
  | { ok: true; value: PreparedAgentRun }
  | { ok: false; error: string }

export async function prepareAgentRun(input: {
  originalPrompt: string
  continuation?: AgentRunContinuation
  session?: AgentRunSession
  runContext: AgentRunSession
  options: UseAgentRunOptions
  hasCognitivePersistence: boolean
  getCognitiveSessionService: () => Promise<CognitiveSessionService>
}): Promise<PrepareAgentRunResult> {
  const { options, runContext } = input
  const priorConversationMessages = [...runContext.messages.value]
  const slashCommand = resolveAgentSlashCommand(input.originalPrompt)
  if (slashCommand) runContext.mode.value = slashCommand.command.mode
  const conversationId =
    runContext.workspace?.ensureConversationId() ?? runContext.workspace?.conversationId.value ?? ''

  const snapshot = captureAgentRunSnapshot({
    prompt: slashCommand?.prompt ?? input.originalPrompt,
    requestedMode: slashCommand?.command.mode ?? runContext.mode.value,
    settings: options.settings.value,
    document: input.session?.documentSnapshot ?? options.document.captureSnapshot(),
    explicitTargets:
      input.session?.explicitTargets?.value ?? options.explicitTargets?.value ?? [],
    workspace: {
      projectId: runContext.workspace?.projectId.value ?? '',
      projectName: runContext.workspace?.projectName.value ?? '未分组 Agent 项目',
      rootDocumentIds: [...(runContext.workspace?.rootDocumentIds.value ?? [])],
      conversationId,
    },
  })
  const activeDocumentId = snapshot.document.id
  const hydratedTargets = await hydrateExplicitDocumentTargets(snapshot, options.document)
  if (!hydratedTargets.ok) return hydratedTargets
  snapshot.explicitTargets = hydratedTargets.targets

  if (!(await options.ensureSecretLoaded())) {
    return { ok: false, error: '密钥库在 3 秒内未就绪，请稍后重试或在 AI 设置中重新填写 API Key。' }
  }
  snapshot.settings.apiKey ||= options.settings.value.apiKey
  if (!snapshot.settings.model.trim()) {
    return { ok: false, error: '请先在 AI 设置中获取或填写模型。' }
  }

  const mode = resolveAiExecutionMode(snapshot.requestedMode, snapshot.prompt)
  let agentIntent = slashCommand?.command.intent ?? inferAiAgentIntent(snapshot.prompt)
  let cognitiveSession: CognitiveSession | null = null
  let learningState: LearningSessionState | null = null
  let learningStateBeforeRun: LearningSessionState | null = null
  let learningUserAttempt: string | null = null
  let resumedLearningSession = false

  if (!slashCommand && mode === 'agent' && conversationId && input.hasCognitivePersistence) {
    const listed = await (await input.getCognitiveSessionService()).listByConversation(conversationId)
    if (!listed.ok) return { ok: false, error: listed.error.message }
    const waiting = listed.value.find(
      (session) => session.modeId === 'learning' && session.status === 'waiting_user',
    )
    if (waiting) {
      const restored = parseLearningSessionState(waiting.state)
      if (!restored) {
        return { ok: false, error: 'Learning Session 状态已损坏，无法继续本次学习。' }
      }
      agentIntent = 'learning'
      cognitiveSession = waiting
      learningState = restored
      learningStateBeforeRun = restored
      learningUserAttempt = snapshot.prompt
      resumedLearningSession = true
    }
  }
  if (agentIntent === 'learning' && !learningState) {
    learningState = createLearningSessionState(snapshot.prompt)
    learningStateBeforeRun = learningState
  }

  if (snapshot.requestedMode === 'auto') {
    options.notify.success(`Auto 已选择 ${getModeLabel(mode)} 处理本次任务`)
  }

  let editPlan: AgentEditPlan | null = null
  if (mode === 'edit' || mode === 'agent') {
    const flushResult = await options.document.flushBeforeEdit()
    if (!flushResult.ok) {
      return { ok: false, error: '当前文档保存失败，暂不能发起 Agent 修改。' }
    }
    if (snapshot.document.id === activeDocumentId) {
      snapshot.document.revision = flushResult.revision ?? snapshot.document.revision
      snapshot.explicitTargets = snapshot.explicitTargets.map((target) =>
        target.kind === 'document' && target.id === activeDocumentId
          ? {
              ...target,
              revision: snapshot.document.revision ?? undefined,
              content: target.content?.replace(
                /revision=(?:unknown|\d+)/g,
                `revision=${snapshot.document.revision ?? 'unknown'}`,
              ),
            }
          : target,
      )
    }
    snapshot.document = await hydrateCanonicalDocumentSnapshot(snapshot.document, options.document)
    editPlan = createAgentEditPlan({ snapshot, mode, createId: options.createId })
    if (!editPlan) {
      return { ok: false, error: '当前文档还没有可修改的块或版本信息。' }
    }
    restrictToolsForIntent(editPlan.task.executionPolicy, agentIntent)
    if (input.continuation) {
      editPlan.task.causationId = input.continuation.previousTaskId
      editPlan.task.executionPolicy.allowedTools = ['submit_document_edits']
      editPlan.task.executionPolicy.maxToolRounds = Math.min(
        editPlan.task.executionPolicy.maxToolRounds,
        10,
      )
    }
    const persistenceError = await createPersistedAgentTask(editPlan.task, options)
    if (persistenceError) return { ok: false, error: persistenceError }
  }

  return {
    ok: true,
    value: {
      snapshot,
      slashCommand,
      priorConversationMessages,
      conversationId,
      mode,
      agentIntent,
      editPlan,
      cognitiveSession,
      learningState,
      learningStateBeforeRun,
      learningUserAttempt,
      resumedLearningSession,
    },
  }
}
