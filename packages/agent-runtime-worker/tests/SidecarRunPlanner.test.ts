import { describe, expect, it } from 'vitest'

import { planSidecarRun } from '../src/SidecarRunPlanner.js'
import { finalizeSidecarRun } from '../src/SidecarRunFinalizer.js'

describe('planSidecarRun', () => {
  it('creates a frozen Runtime request and context bundle inside the sidecar', async () => {
    const planned = await planSidecarRun(submission())

    expect(planned.task).toMatchObject({
      id: 'task-1',
      runId: 'run-1',
      status: 'running',
      contextBundleId: expect.any(String),
    })
    expect(planned.request).toMatchObject({
      runId: 'run-1',
      workItemId: 'task-1',
      sessionId: 'conversation-1',
      modelPolicy: { credentialRef: { kind: 'provider_secret' } },
    })
    expect(planned.request.toolManifest.some((tool) => tool.name === 'submit_document_edits')).toBe(
      true,
    )
    expect(planned.contextBundle.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: 'doc-1', blockId: 'block-1' }),
      ]),
    )
  })

  it('compiles read-only Cognitive policy and output contract in the sidecar', async () => {
    const planned = await planSidecarRun({ ...submission(), intent: 'review' })

    expect(planned.request.executionPolicy).toMatchObject({
      riskLevel: 'read_only',
      allowWriteProposals: false,
    })
    expect(planned.request.outputContract).toMatchObject({ id: 'review-result', version: 1 })
    expect(planned.request.toolManifest.some((tool) => tool.name === 'submit_document_edits')).toBe(
      false,
    )
  })

  it('compiles a completed sidecar proposal without WebView persistence', async () => {
    const planned = await planSidecarRun(submission())
    const finalization = await finalizeSidecarRun(planned.request, {
      runId: planned.request.runId,
      output: JSON.stringify({
        outcome: 'proposal',
        finalAnswer: '建议更新当前段落。',
        patches: [
          {
            documentId: 'doc-1',
            operation: 'replace',
            blockId: 'block-1',
            targetBlockIds: ['block-1'],
            after: '更新后的内容',
            reason: '修正表述。',
          },
        ],
      }),
      rounds: 2,
      toolCalls: [],
      finishReason: 'stop',
    })

    expect(finalization.taskStatus).toBe('waiting_confirmation')
    expect(finalization.patches).toMatchObject([
      { taskId: planned.task.id, documentId: 'doc-1', blockId: 'block-1' },
    ])
    expect(finalization.report.patchCount).toBe(1)
  })
})

function submission() {
  return {
    version: 1 as const,
    runId: 'run-1',
    workItemId: 'task-1',
    sessionId: 'conversation-1',
    document: {
      id: 'doc-1',
      title: 'Document',
      tags: [],
      sourceUrl: '',
      author: '',
      text: 'Original',
      markdown: 'Original',
      revision: 3,
      blocks: [{ id: 'block-1', type: 'paragraph', text: 'Original', index: 0 }],
      selectedBlockIds: ['block-1'],
      documents: [
        { id: 'doc-1', title: 'Document', documentKind: 'article' as const, isDeleted: false },
      ],
    },
    workspace: {
      projectId: 'project-1',
      projectName: 'Project',
      rootDocumentIds: ['doc-1'],
      conversationId: 'conversation-1',
    },
    objective: 'Improve the document',
    intent: 'default' as const,
    systemInstructions: 'System instructions',
    modelPolicy: {
      provider: 'openai' as const,
      model: 'gpt-test',
      endpoint: 'https://example.test/v1',
      temperature: 0.4,
      topP: 1,
      reasoningEffort: 'auto' as const,
      maxOutputTokens: 2048,
      credentialRef: { kind: 'provider_secret' as const, provider: 'openai' as const },
    },
    configuredMaxTokens: 2048,
    externalTools: [],
    explicitTargets: [],
    correlationId: 'correlation-1',
    causationId: null,
  }
}
