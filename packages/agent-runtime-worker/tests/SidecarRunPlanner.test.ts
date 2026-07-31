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

  it('includes prior conversation context in the frozen Runtime context', async () => {
    const planned = await planSidecarRun({
      ...submission(),
      objective: '尝试完成刚刚我给你的任务',
      conversationContext: [
        '同一对话的延续上下文：',
        '用户：',
        '创建一个随机数生成器网页，并把结果写入测试分组的新文档。',
      ].join('\n\n'),
    })

    expect(planned.request.compiledContext).toContain('同一对话的延续上下文')
    expect(planned.request.compiledContext).toContain('创建一个随机数生成器网页')
  })

  it('keeps MCP tools visible for document creation tasks', async () => {
    const planned = await planSidecarRun({
      ...submission(),
      objective: '调用 Qoder 创建网页，再把结果写入新文档',
      intent: 'create',
      externalTools: [qoderMcpTool()],
    })

    expect(planned.request.executionPolicy.allowedTools).toContain('mcp:*')
    expect(planned.request.toolManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'mcp__qoder__execute_task',
          source: expect.objectContaining({ kind: 'mcp', serverId: 'qoder' }),
        }),
      ]),
    )
  })

  it('gives signal runs autonomous read access and only local organizer writes', async () => {
    const planned = await planSidecarRun({ ...submission(), intent: 'signal' })
    const toolNames = planned.request.toolManifest.map((tool) => tool.name)

    expect(planned.request.executionPolicy).toMatchObject({
      riskLevel: 'propose_write',
      allowWriteProposals: false,
      allowUserInput: false,
    })
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'search_documents',
        'read_document',
        'read_personal_organizer',
        'upsert_personal_todo',
        'upsert_personal_calendar_event',
      ]),
    )
    expect(toolNames).not.toContain('submit_document_edits')
    expect(toolNames).not.toContain('create_automation_draft')
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

function qoderMcpTool() {
  return {
    serverId: 'qoder',
    serverName: 'Qoder',
    name: 'execute_task',
    runtimeName: 'mcp__qoder__execute_task',
    description: 'Delegate a coding task to Qoder.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    readOnly: false,
    serverTrusted: true,
    executionAuthorization: 'required' as const,
    mutationApproval: 'not_required' as const,
    externalActionApproval: 'not_required' as const,
    maxCallsPerRun: 8,
    tags: ['external.may_write' as const],
    presentation: { label: 'Qoder task', category: 'external' as const },
  }
}
