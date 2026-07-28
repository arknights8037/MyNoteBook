import type { AgentRuntimeResult } from '@/services/agent/AgentRuntime'
import type { AgentCommunicationResult } from '@/services/agent/AgentCommunicationService'
import { appendKnowledgeSources, type KnowledgeSource } from '@/models/knowledge/knowledgeRetrieval'
import { persistAgentRunResult } from './agentRunPersistence'
import type { AgentRunOutcome } from './agentRunResult'
import { resolveAgentRunResult } from './agentRunResult'
import { resolveCognitiveIntentResult } from './agentRunIntentStrategy'
import type { LearningSessionState, LearningTurnResult, ResearchCandidateRef, ResearchResult, ReviewResult } from '@/models/cognitive/cognitive'
import type { CognitiveResultProvenance } from '@/models/cognitive/cognitive'
import type { AiChatMode } from '@/models/ai/aiChatMode'
import type { AiConversationMessage } from '@/composables/useAiConversation'
import type { AgentRunSnapshot, UseAgentRunOptions } from './types'
import type { AgentEditPlan } from './agentRunPreparation'
import type { ReadableDocument } from './agentRunToolExecutorFactory'

interface AgentRunOutputResolutionInput {
  output: string
  mode: AiChatMode
  editPlan: AgentEditPlan | null
  snapshot: AgentRunSnapshot
  sources: KnowledgeSource[]
  readableDocuments: Map<string, ReadableDocument>
  agentRounds: number
  agentToolCallCount: number
  agentDiagnostics: Pick<AgentRuntimeResult, 'finishReason' | 'usage'>
  agentIntent: string
  cognitiveRun: {
    spec: {
      modeId: string
      modeVersion: string
      templateId: string
      templateVersion: string
      outputContractId: string
      skillIds: string[]
    }
    systemPrompt: string
    outputContract: { validate: (data: unknown) => unknown }
  } | null
  cognitiveSession: { id: string; version: number } | null
  learningState: LearningSessionState | null
  learningStateBeforeRun: LearningSessionState | null
  learningUserAttempt: string | null
  resumedLearningSession: boolean
  session: { background?: boolean } | null
  slashCommand: { command: { intent: string } } | null
  options: UseAgentRunOptions
  assistantMessage: AiConversationMessage | undefined
  hasCognitivePersistence: () => boolean
  getCognitiveSessionService: () => Promise<{
    waitForUser: (id: string, version: number, state: LearningSessionState) => Promise<{ ok: boolean; value: { id: string; version: number }; error?: { message: string } }>
    complete: (id: string, version: number, state: unknown) => Promise<{ ok: boolean; value: { id: string; version: number }; error?: { message: string } }>
    cancel: (id: string, version: number) => Promise<{ ok: boolean; error?: { message: string } }>
  }>
  setSummary: (summary: string) => void
  runtime: { complete: (detail: string) => void; cancel: (detail: string) => void; fail: (detail: string) => void }
}

export interface AgentRunOutputResolution {
  patchSet: { patches: Array<{ documentId: string; operation: string }> } | null
  outcome: AgentRunOutcome
  summary: string
  researchResult: ResearchResult | null
  reviewResult: ReviewResult | null
  learningResult: LearningTurnResult | null
  researchCandidates: ResearchCandidateRef[]
  cognitiveProvenance: CognitiveResultProvenance | null
  lastRunReport: AgentCommunicationResult | null
  agentTaskResultPersisted: boolean
  cognitiveSession: { id: string; version: number } | null
  learningState: LearningSessionState | null
}

export async function resolveAgentRunOutput(
  input: AgentRunOutputResolutionInput,
): Promise<AgentRunOutputResolution> {
  const {
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
    cognitiveRun,
    cognitiveSession,
    learningState,
    learningUserAttempt,
    options,
    assistantMessage,
  } = input

  let patchSet: { patches: Array<{ documentId: string; operation: string }> } | null = null
  let outcome: AgentRunOutcome = 'proposal'
  let summary = ''
  let researchResult: ResearchResult | null = null
  let reviewResult: ReviewResult | null = null
  let learningResult: LearningTurnResult | null = null
  let researchCandidates: ResearchCandidateRef[] = []
  let cognitiveProvenance: CognitiveResultProvenance | null = null
  let agentTaskResultPersisted = false
  let updatedCognitiveSession = cognitiveSession
  let updatedLearningState = learningState

  // Phase 1: Result resolution
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
      updatedLearningState = resolved.learningState ?? learningState
      summary = resolved.summary
      outcome = 'no_change'
    } else {
      const result = await resolveAgentRunResult({
        output,
        mode: mode as 'edit' | 'agent',
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
      patchSet = result.patchSet as { patches: Array<{ documentId: string; operation: string }> } | null
      outcome = result.outcome
      summary = result.summary
    }
  }

  // Phase 2: Build lastRunReport
  const lastRunReport: AgentCommunicationResult | null =
    (mode === 'edit' || mode === 'agent') && editPlan
      ? {
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
                      state: updatedLearningState,
                    },
                  }
                : {}),
          ...agentDiagnostics,
        }
      : null

  // Phase 3: Cognitive provenance and research candidates
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

  // Phase 4: Format assistant message
  if (assistantMessage) {
    const formatAgentRunSummaryModule = await import('./agentRunResult')
    assistantMessage.content =
      mode === 'ask' && sources.length > 0
        ? appendKnowledgeSources(output, sources)
        : mode === 'edit' || mode === 'agent'
          ? formatAgentRunSummaryModule.formatAgentRunSummary({
              summary,
              outcome,
              patchCount: patchSet?.patches.length ?? 0,
              rounds: agentRounds,
              toolCallCount: mode === 'agent' ? agentToolCallCount : 0,
            })
          : assistantMessage.content
    assistantMessage.status = 'done'
    input.setSummary(
      summary.trim() ||
        (outcome === 'proposal'
          ? '已生成待确认的修改提案。'
          : outcome === 'blocked'
            ? '现有信息不足，任务暂时无法继续。'
            : '任务已完成。'),
    )
    if (researchResult && cognitiveProvenance) {
      assistantMessage.researchResult = researchResult
      assistantMessage.cognitiveProvenance = cognitiveProvenance
      assistantMessage.researchCandidates = researchCandidates
    }
    if (reviewResult && cognitiveProvenance) {
      assistantMessage.reviewResult = reviewResult
      assistantMessage.cognitiveProvenance = cognitiveProvenance
    }
    if (learningResult && updatedLearningState && cognitiveProvenance) {
      assistantMessage.learningResult = learningResult
      assistantMessage.learningState = updatedLearningState
      assistantMessage.cognitiveProvenance = cognitiveProvenance
    }
  }

  // Phase 5: Learning result persistence
  const cognitiveResult = researchResult ?? reviewResult ?? learningResult
  if (learningResult && editPlan) {
    await persistAgentRunResult({
      task: editPlan.task,
      patchSet: patchSet as Parameters<typeof persistAgentRunResult>[0]['patchSet'],
      outcome,
      patches: options.patches,
    })
    agentTaskResultPersisted = true
  }

  // Phase 6: Cognitive session completion
  if (cognitiveResult && updatedCognitiveSession) {
    if (agentIntent === 'learning' && learningResult && updatedLearningState) {
      if (input.hasCognitivePersistence()) {
        const service = await input.getCognitiveSessionService()
        const updated =
          learningResult.phase === 'waiting_user'
            ? await service.waitForUser(
                updatedCognitiveSession.id,
                updatedCognitiveSession.version,
                updatedLearningState,
              )
            : await service.complete(
                updatedCognitiveSession.id,
                updatedCognitiveSession.version,
                updatedLearningState,
              )
        if (!updated.ok) throw new Error(updated.error!.message)
        updatedCognitiveSession = updated.value
      } else {
        updatedCognitiveSession = {
          ...updatedCognitiveSession,
          version: updatedCognitiveSession.version + 1,
        }
      }
    } else if (input.hasCognitivePersistence()) {
      const service = await input.getCognitiveSessionService()
      const completed = await service.complete(
        updatedCognitiveSession.id,
        updatedCognitiveSession.version,
        {
          runId: editPlan?.task.id,
          phase: 'completed',
          result: cognitiveResult,
          candidateIds: researchCandidates.map((candidate) => candidate.candidateId),
        },
      )
      if (!completed.ok) throw new Error(completed.error!.message)
      updatedCognitiveSession = completed.value
    }
  }

  // Phase 7: Task persistence and document review
  if (editPlan && !agentTaskResultPersisted) {
    const patchTargetDocumentId = patchSet?.patches.find(
      (patch) => patch.operation !== 'create_document' && patch.operation !== 'create_group',
    )?.documentId
    await persistAgentRunResult({
      task: editPlan.task,
      patchSet: patchSet as Parameters<typeof persistAgentRunResult>[0]['patchSet'],
      outcome,
      patches: options.patches,
    })
    if (
      !input.session?.background &&
      patchTargetDocumentId &&
      patchTargetDocumentId !== snapshot.document.id
    ) {
      await options.document.openDocumentForReview(patchTargetDocumentId)
    }
  }

  return {
    patchSet,
    outcome,
    summary,
    researchResult,
    reviewResult,
    learningResult,
    researchCandidates,
    cognitiveProvenance,
    lastRunReport,
    agentTaskResultPersisted,
    cognitiveSession: updatedCognitiveSession,
    learningState: updatedLearningState,
  }
}
