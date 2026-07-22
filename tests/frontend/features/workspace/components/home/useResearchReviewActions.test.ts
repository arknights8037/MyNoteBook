import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useResearchReviewActions } from '@/features/workspace/components/home/useResearchReviewActions'

describe('useResearchReviewActions', () => {
  it('refuses to resolve an issue whose source is stale', async () => {
    const runAgent = vi.fn(async () => undefined)
    const error = vi.fn()
    const actions = useResearchReviewActions({
      messages: ref([]),
      isRunning: ref(false),
      currentDocumentId: ref('doc-1'),
      selectDocument: vi.fn(async () => undefined),
      runAgent,
      notify: { success: vi.fn(), error },
    })

    await actions.resolveReviewIssue({
      messageId: 'message-1',
      issue: {
        issueId: 'issue-1',
        severity: 'high',
        category: 'correctness',
        title: '过期问题',
        description: '来源已经变化',
        evidence: '',
        recommendation: '',
        sourceState: 'stale',
        sources: [],
      },
    })

    expect(error).toHaveBeenCalledWith('该问题的来源已变化，请重新执行 Review')
    expect(runAgent).not.toHaveBeenCalled()
  })
})
