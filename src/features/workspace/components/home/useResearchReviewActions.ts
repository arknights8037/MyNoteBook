import type { Ref } from 'vue'

import type { AiConversationMessage } from '@/composables/useAiConversation'
import type { ReviewIssue, ResearchCandidateRef } from '@/models/cognitive/cognitive'
import type { ResearchCandidateService } from '@/services/cognitive/ResearchCandidateService'

export interface ResearchCandidateActionInput {
  messageId: string
  itemId: string
  candidateId: string
  expectedVersion: number
  action: 'keep' | 'approve' | 'reject'
  title?: string
  content?: string
}

interface ResearchReviewActionsOptions {
  messages: Ref<AiConversationMessage[]>
  getResearchCandidateService?: () => Promise<ResearchCandidateService>
  isRunning: Readonly<Ref<boolean>>
  currentDocumentId: Readonly<Ref<string>>
  selectDocument: (documentId: string) => Promise<void>
  runAgent: (prompt: string) => Promise<void>
  notify: { success(message: string): void; error(message: string): void }
}

export function useResearchReviewActions(options: ResearchReviewActionsOptions) {
  async function handleResearchCandidateAction(input: ResearchCandidateActionInput): Promise<void> {
    const targetMessage = options.messages.value.find((item) => item.id === input.messageId)
    const candidateIndex = targetMessage?.researchCandidates?.findIndex(
      (candidate) =>
        candidate.itemId === input.itemId && candidate.candidateId === input.candidateId,
    )
    if (!targetMessage?.researchResult || candidateIndex === undefined || candidateIndex < 0) return
    const current = targetMessage.researchCandidates?.[candidateIndex]
    if (!current) return

    try {
      const provider = options.getResearchCandidateService
      if (!provider) throw new Error('未配置研究候选服务。')
      const service = await provider()
      let next: ResearchCandidateRef = current
      if (
        input.title !== undefined &&
        input.content !== undefined &&
        (input.title.trim() !== current.title || input.content.trim() !== current.content)
      ) {
        const revised = await service.revise({
          candidateId: input.candidateId,
          expectedVersion: input.expectedVersion,
          title: input.title,
          content: input.content,
        })
        if (!revised.ok) throw new Error(revised.error.message)
        next = revised.value
      }
      const decided = await service.decide({
        candidateId: next.candidateId,
        expectedVersion: next.version,
        action: input.action,
      })
      next = decided.ok
        ? decided.value
        : {
            ...next,
            sourceState: decided.error.code === 'revision-conflict' ? 'stale' : next.sourceState,
            error: decided.error.message,
          }
      targetMessage.researchCandidates!.splice(candidateIndex, 1, next)
      if (!decided.ok) return options.notify.error(decided.error.message)

      if (input.action === 'approve') {
        const relations = await service.materializeApprovedRelations({
          relations: targetMessage.researchResult.relations,
          candidates: targetMessage.researchCandidates!,
        })
        if (!relations.ok) throw new Error(relations.error.message)
      }
      options.notify.success(
        input.action === 'approve'
          ? '候选已接受为正式知识'
          : input.action === 'reject'
            ? '候选已拒绝'
            : '候选已保留，稍后仍可处理',
      )
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      targetMessage.researchCandidates!.splice(candidateIndex, 1, { ...current, error: errorText })
      options.notify.error(errorText)
    }
  }

  async function resolveReviewIssue(input: {
    messageId: string
    issue: ReviewIssue
  }): Promise<void> {
    if (options.isRunning.value) return options.notify.error('请先等待当前 Agent 任务结束')
    if (input.issue.sourceState === 'stale') {
      return options.notify.error('该问题的来源已变化，请重新执行 Review')
    }
    const targetDocumentId = input.issue.sources[0]?.documentId
    if (targetDocumentId && targetDocumentId !== options.currentDocumentId.value) {
      await options.selectDocument(targetDocumentId)
    }
    const { buildReviewIssueResolutionPrompt } = await import('@/services/cognitive/ReviewResultService')
    await options.runAgent(buildReviewIssueResolutionPrompt(input.issue))
  }

  return { handleResearchCandidateAction, resolveReviewIssue }
}
