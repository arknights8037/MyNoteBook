import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  selectRelevantApprovedKnowledge,
  useAgentRun,
  type AgentRunDocumentSnapshot,
  type AgentRunServiceDependencies,
} from '@/composables/useAgentRun'
import type { AiConversationMessage } from '@/composables/useAiConversation'
import { createAiSettings, type AiSettings } from '@/models/ai/ai'
import type { AgentRepository } from '@/repositories/agent/AgentRepository'
import type { DocumentBlock } from '@/models/documents/documentBlock'
import type { CognitiveSession, CreateCognitiveSessionInput } from '@/models/cognitive/cognitive'
import type { CognitiveSessionService } from '@/services/cognitive/CognitiveSessionService'
import { ok } from '@/models/shared/result'
import type { McpClientPort } from '@/services/ports/McpClientPort'

const completion = vi.hoisted(() => vi.fn())
const agentLoop = vi.hoisted(() => vi.fn())
const listMcpTools = vi.hoisted(() => vi.fn())
const callMcpTool = vi.hoisted(() => vi.fn())

vi.mock('@/services/ai/AiMarkdownService', () => ({
  runAiMarkdownCompletion: completion,
}))
vi.mock('@/services/agent/AgentRuntime', () => ({
  runAgentToolLoop: agentLoop,
}))
describe('useAgentRun', () => {
  beforeEach(() => {
    completion.mockReset()
    completion.mockImplementation(async (input) => {
      input.onDelta('冻结上下文回答')
      return '冻结上下文回答'
    })
    agentLoop.mockReset()
    listMcpTools.mockReset()
    listMcpTools.mockResolvedValue([])
    callMcpTool.mockReset()
    callMcpTool.mockResolvedValue({ ok: true })
  })

  it('freezes document and model context before the first asynchronous boundary', async () => {
    const secret = deferred<boolean>()
    const currentSnapshot = snapshot()
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'model-at-start'
    const run = createRun(settings, currentSnapshot, () => secret.promise)

    const promise = run.workflow.run()
    currentSnapshot.title = '切换后的文档'
    currentSnapshot.text = '切换后的正文'
    settings.value.model = 'model-after-start'
    secret.resolve(true)
    await promise

    expect(completion).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('标题：运行时文档'),
        settings: expect.objectContaining({ model: 'model-at-start' }),
      }),
    )
    expect(completion.mock.calls[0]?.[0].context).toContain('运行开始正文')
    expect(completion.mock.calls[0]?.[0].context).not.toContain('切换后的正文')
    expect(run.messages.value.at(-1)?.content).toContain('冻结上下文回答')
    expect(run.workflow.runtimeState.value).toMatchObject({
      status: 'completed',
      phase: 'completed',
      detail: '任务已完成',
    })
    expect(run.workflow.runtimeState.value.completedAt).toEqual(expect.any(Number))
  })

  it('runs an A2A request in a detached conversation without touching the active chat', async () => {
    agentLoop.mockResolvedValue(noChangeAgentResult(1))
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent')
    run.messages.value = [message('active-user', 'user', '当前用户对话')]
    run.prompt.value = '当前输入框内容'
    const detachedMessages = ref<AiConversationMessage[]>([])
    const detachedPrompt = ref('后台请求')
    const detachedConversationId = ref<string | null>('a2a-request-1')

    await run.workflow.run('后台请求', undefined, {
      mode: ref('agent'),
      prompt: detachedPrompt,
      messages: detachedMessages,
      error: ref(''),
      documentSnapshot: snapshot(),
      explicitTargets: ref([]),
      background: true,
      workspace: {
        projectId: ref(''),
        projectName: ref('外部 Agent 任务'),
        rootDocumentIds: ref([]),
        conversationId: detachedConversationId,
        ensureConversationId: () => 'a2a-request-1',
      },
    })

    expect(run.messages.value).toEqual([message('active-user', 'user', '当前用户对话')])
    expect(run.prompt.value).toBe('当前输入框内容')
    expect(detachedMessages.value.map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(run.workflow.activeConversationId.value).toBe('a2a-request-1')
  })

  it('aborts an active completion and restores the running state', async () => {
    completion.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true)

    const promise = run.workflow.run()
    await vi.waitFor(() => expect(run.isRunning.value).toBe(true))
    run.workflow.stop()
    await promise

    expect(run.isRunning.value).toBe(false)
    expect(run.messages.value.at(-1)?.status).toBe('done')
    expect(run.workflow.runtimeState.value).toMatchObject({
      status: 'cancelled',
      phase: 'cancelled',
      detail: '任务已停止',
    })
  })

  it('clears the latest runtime telemetry with the conversation', async () => {
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true)
    await run.workflow.run()

    run.workflow.resetRuntime()

    expect(run.workflow.runtimeState.value).toMatchObject({ status: 'idle', toolCalls: [] })
  })

  it('reloads canonical Markdown blocks when an external Agent request arrives before the editor ref', async () => {
    let observation: unknown
    agentLoop.mockImplementation(async (input) => {
      observation = await input.executeTool({ name: 'get_current_document', arguments: {} })
      return noChangeAgentResult(1)
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const currentSnapshot = snapshot()
    currentSnapshot.blocks = []
    currentSnapshot.markdown = ''
    const canonicalBlocks: DocumentBlock[] = [
      {
        id: 'block-1',
        documentId: 'doc-1',
        type: 'paragraph',
        index: 0,
        contentJson: JSON.stringify({
          type: 'paragraph',
          attrs: { id: 'block-1' },
          content: [{ type: 'text', text: '运行开始正文', marks: [{ type: 'bold' }] }],
        }),
        plainText: '运行开始正文',
        documentRevision: 1,
        updatedAt: Date.now(),
      },
    ]
    const run = createRun(
      settings,
      currentSnapshot,
      async () => true,
      'agent',
      '更新当前文档',
      canonicalBlocks,
    )

    await run.workflow.run()

    expect(agentLoop).toHaveBeenCalled()
    expect(observation).toMatchObject({
      ok: true,
      value: { blocks: [expect.objectContaining({ id: 'block-1', markdown: '**运行开始正文**' })] },
    })
  })

  it('routes an auto page-creation prompt to Agent with create intent', async () => {
    agentLoop.mockResolvedValue({
      output: JSON.stringify({
        outcome: 'no_change',
        commands: [],
        patches: [],
        finalAnswer: '缺少页面内容。',
      }),
      rounds: 1,
      toolCalls: [],
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'auto', '创建页面')

    await run.workflow.run()

    expect(completion).not.toHaveBeenCalled()
    expect(agentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '创建页面',
        intent: 'create',
        executionPolicy: expect.objectContaining({
          allowedTools: expect.arrayContaining(['create_document', 'create_group']),
        }),
      }),
    )
    expect(agentLoop.mock.calls[0]?.[0].executionPolicy.allowedTools).not.toContain('execute_shell')
    expect(run.messages.value[0]?.mode).toBe('agent')
  })

  it('uses a read-only minimal tool bundle for research intent', async () => {
    agentLoop.mockResolvedValue({
      output: JSON.stringify({
        summary: '制度存在一项明确差异。',
        items: [
          {
            id: 'C1',
            kind: 'claim',
            title: '审批差异',
            content: '两份制度的审批范围不同。',
            confidence: null,
            validationStatus: 'unverified',
            validationMessage: '尚未定位到稳定来源块。',
            sources: [],
          },
        ],
        relations: [],
        unresolvedQuestions: ['哪份制度当前有效？'],
      }),
      rounds: 2,
      toolCalls: [],
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '/research 对比制度')

    await run.workflow.run()

    expect(agentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'research',
        executionPolicy: expect.objectContaining({
          allowWriteProposals: false,
          riskLevel: 'read_only',
        }),
      }),
    )
    expect(agentLoop.mock.calls[0]?.[0].executionPolicy.allowedTools).not.toContain(
      'submit_document_edits',
    )
    expect(agentLoop.mock.calls[0]?.[0].outputContract?.id).toBe('research-result')
    expect(run.messages.value.at(-1)?.researchResult?.items[0]?.kind).toBe('claim')
    expect(run.messages.value.at(-1)?.cognitiveProvenance).toMatchObject({
      modeId: 'research',
      templateId: 'research-conclusions',
      outputContractId: 'research-result',
    })
    expect(run.workflow.lastRunReport.value?.cognitive).toMatchObject({
      mode: 'research',
      result: { summary: '制度存在一项明确差异。' },
    })
  })

  it('carries the previous Research result into a write-oriented follow-up', async () => {
    agentLoop.mockResolvedValue(noChangeAgentResult(1))
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(
      settings,
      snapshot(),
      async () => true,
      'agent',
      '把上面的研究结论整理成一个新文档',
    )
    run.messages.value.push(
      {
        id: 'previous-user',
        role: 'user',
        mode: 'agent',
        content: '/research 对比三份资料',
        status: 'done',
      },
      {
        id: 'previous-research',
        role: 'assistant',
        mode: 'agent',
        content: '三份资料的边界不同。',
        status: 'done',
        researchResult: {
          summary: '三份资料分别覆盖架构、能力和项目参考。',
          items: [
            {
              id: 'C1',
              kind: 'claim',
              title: '运行时约束优先',
              content: '生产 Agent 的关键是受控运行时，而非单一推理范式。',
              confidence: 0.8,
              validationStatus: 'unverified',
              validationMessage: '来源是导入的对话资产。',
              sources: [],
            },
          ],
          relations: [],
          unresolvedQuestions: ['第一阶段是否只支持短任务？'],
        },
      },
    )

    await run.workflow.run()

    expect(agentLoop.mock.calls[0]?.[0].context).toContain('同一对话的延续上下文')
    expect(agentLoop.mock.calls[0]?.[0].context).toContain('生产 Agent 的关键是受控运行时')
    expect(agentLoop.mock.calls[0]?.[0].context).toContain('第一阶段是否只支持短任务')
  })

  it('binds review intent to a read-only structured result without creating patches', async () => {
    agentLoop.mockResolvedValue({
      output: JSON.stringify({
        summary: '发现一项无来源结论。',
        issues: [
          {
            id: 'M1',
            issueType: 'missing_source',
            severity: 'warning',
            title: '结论缺少来源',
            explanation: '正文给出结论但没有引用证据。',
            affectedText: '该方案一定能提升效率。',
            suggestedAction: '补充可定位来源或收窄表述。',
            sources: [],
          },
        ],
        unresolvedQuestions: [],
      }),
      rounds: 2,
      toolCalls: [],
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '/review 检查结论')

    await run.workflow.run()

    expect(agentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'review',
        outputContract: expect.objectContaining({ id: 'review-result' }),
        executionPolicy: expect.objectContaining({
          allowWriteProposals: false,
          riskLevel: 'read_only',
        }),
      }),
    )
    expect(agentLoop.mock.calls[0]?.[0].executionPolicy.allowedTools).not.toContain(
      'submit_document_edits',
    )
    expect(run.messages.value.at(-1)?.reviewResult?.issues[0]).toMatchObject({
      issueType: 'missing_source',
      sourceState: 'unverified',
    })
    expect(run.messages.value.at(-1)?.cognitiveProvenance).toMatchObject({
      modeId: 'review',
      templateId: 'review-findings',
      outputContractId: 'review-result',
    })
    expect(run.workflow.lastRunReport.value?.cognitive).toMatchObject({
      mode: 'review',
      result: { summary: '发现一项无来源结论。' },
    })
  })

  it('starts Learning by asking for an attempt without assessing understanding', async () => {
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '/learn 事件循环')

    await run.workflow.run()

    expect(agentLoop).not.toHaveBeenCalled()
    expect(run.messages.value.at(-1)?.learningState).toMatchObject({
      attempts: [],
      understandingState: 'not_assessed',
      nextStep: 'await_attempt',
    })
    expect(run.messages.value.at(-1)?.learningResult?.feedback).toEqual({
      correctPoints: [],
      omissions: [],
      misconceptions: [],
    })
    expect(run.messages.value.at(-1)?.learningResult?.nextPrompt.content).toContain('事件循环')
    expect(run.workflow.lastRunReport.value?.cognitive).toMatchObject({
      mode: 'learning',
      result: { phase: 'waiting_user' },
      state: { topic: '事件循环', attempts: [] },
    })
  })

  it('resumes the same waiting Learning Session for an ordinary user reply', async () => {
    const memory = createMemoryCognitiveSessionService()
    agentLoop.mockResolvedValueOnce({
      output: JSON.stringify(attemptLearningTurn()),
      rounds: 1,
      toolCalls: [],
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(
      settings,
      snapshot(),
      async () => true,
      'agent',
      '/learn 事件循环',
      [],
      memory.service,
    )

    await run.workflow.run()
    const sessionId = run.messages.value.at(-1)?.cognitiveProvenance?.sessionId
    run.prompt.value = '宏任务之后会先清空微任务队列。'
    await run.workflow.run()

    expect(agentLoop.mock.calls[0]?.[0]).toMatchObject({
      intent: 'learning',
      outputContract: { id: 'learning-turn' },
    })
    expect(agentLoop.mock.calls[0]?.[0].systemPrompt).toContain('本轮用户尝试')
    expect(run.messages.value.at(-1)?.cognitiveProvenance?.sessionId).toBe(sessionId)
    expect(run.messages.value.at(-1)?.learningState).toMatchObject({
      attempts: [expect.objectContaining({ response: '宏任务之后会先清空微任务队列。' })],
      understandingState: 'partial',
    })
    expect(memory.current()?.status).toBe('waiting_user')
    expect(memory.current()?.state).toMatchObject({ attempts: [expect.any(Object)] })
  })

  it('restores the previous waiting state when a resumed Learning turn fails validation', async () => {
    const memory = createMemoryCognitiveSessionService()
    agentLoop.mockResolvedValueOnce({
      output: JSON.stringify({ ...attemptLearningTurn(), evidence: '' }),
      rounds: 1,
      toolCalls: [],
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(
      settings,
      snapshot(),
      async () => true,
      'agent',
      '/learn 事件循环',
      [],
      memory.service,
    )

    await run.workflow.run()
    run.prompt.value = '一次不完整的回答'
    await run.workflow.run()

    expect(memory.current()).toMatchObject({
      status: 'waiting_user',
      state: { attempts: [], understandingState: 'not_assessed' },
    })
    expect(run.messages.value.at(-1)).toMatchObject({ status: 'error' })
    expect(run.messages.value.at(-1)?.learningResult).toBeUndefined()
    expect(run.messages.value.at(-1)?.learningState).toBeUndefined()
  })

  it('pauses an interactive slash command for the authorizer and resumes the same run', async () => {
    agentLoop.mockImplementation(async (input) => {
      const authorization = await input.executeTool({
        name: 'request_authorizer_input',
        arguments: {
          question: '采用哪种组织方式？',
          context: '这会影响新页面结构。',
          options: ['按阶段', '按负责人'],
          allowFreeText: true,
        },
      })
      return {
        output: JSON.stringify({
          outcome: 'no_change',
          commands: [],
          patches: [],
          finalAnswer: `已按授权继续：${authorization.value.answer}`,
        }),
        rounds: 2,
        toolCalls: [],
      }
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(
      settings,
      snapshot(),
      async () => true,
      'agent',
      '/interactive 整理发布流程',
    )

    const promise = run.workflow.run()
    await vi.waitFor(() =>
      expect(run.workflow.runtimeState.value.status).toBe('waiting_authorizer'),
    )
    const request = run.workflow.runtimeState.value.authorizationRequest
    expect(request).toMatchObject({ question: '采用哪种组织方式？' })
    expect(agentLoop.mock.calls[0]?.[0]).toMatchObject({
      prompt: '整理发布流程',
      intent: 'interactive',
    })
    expect(agentLoop.mock.calls[0]?.[0].systemPrompt).toContain('必须使用 request_authorizer_input')

    expect(run.workflow.answerAuthorization(request?.id ?? '', '按阶段')).toBe(true)
    await promise

    expect(run.workflow.runtimeState.value.status).toBe('completed')
    expect(run.messages.value.at(-1)?.content).toContain('已按授权继续：按阶段')
    expect(run.messages.value.at(-1)?.agentRuntime).toMatchObject({
      status: 'completed',
      completedAt: expect.any(Number),
      authorizationRequest: null,
    })
  })

  it('cancels cleanly while waiting for an authorizer answer', async () => {
    agentLoop.mockImplementation(async (input) => {
      const authorization = await input.executeTool({
        name: 'request_authorizer_input',
        arguments: { question: '是否继续？', options: ['继续', '停止'] },
      })
      if (!authorization.ok) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      return { output: '', rounds: 1, toolCalls: [] }
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '/interactive 整理内容')

    const promise = run.workflow.run()
    await vi.waitFor(() =>
      expect(run.workflow.runtimeState.value.status).toBe('waiting_authorizer'),
    )
    run.workflow.stop()
    await promise

    expect(run.isRunning.value).toBe(false)
    expect(run.workflow.runtimeState.value).toMatchObject({
      status: 'cancelled',
      authorizationRequest: null,
    })
    expect(
      run.workflow.runtimeState.value.timelineEvents.every((event) => event.status !== 'running'),
    ).toBe(true)
  })

  it('stores a compact valid history snapshot while executing tools with full Markdown', async () => {
    const markdown = `# 原文\n\n${'完整段落内容。'.repeat(2_000)}`
    agentLoop.mockResolvedValue({
      ...noChangeAgentResult(1),
      toolCalls: [
        {
          id: 'call-markdown',
          taskId: 'task-1',
          toolName: 'submit_document_edits',
          argumentsJson: JSON.stringify({ documentId: 'doc-1', markdown }),
          resultJson: JSON.stringify({
            documents: [
              {
                id: 'doc-1',
                title: '原始文档',
                url: 'https://example.com/doc-1',
                markdown,
              },
            ],
          }),
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
          error: null,
        },
      ],
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '处理长文档')

    await run.workflow.run()

    const stored = run.messages.value.at(-1)?.agentRuntime?.toolCalls[0]
    expect(stored).toBeDefined()
    expect(stored!.argumentsJson.length).toBeLessThan(markdown.length)
    expect(JSON.parse(stored!.argumentsJson)).toMatchObject({
      documentId: 'doc-1',
      markdown: expect.stringContaining(`原文共 ${markdown.length} 字符`),
    })
    expect(JSON.parse(stored!.resultJson ?? '{}').documents[0]).toMatchObject({
      title: '原始文档',
      url: 'https://example.com/doc-1',
      markdown: expect.stringContaining('历史快照仅保留预览'),
    })
  })

  it('approves an untrusted MCP server once for the rest of the current task', async () => {
    listMcpTools.mockResolvedValue([mcpTool(false)])
    agentLoop.mockImplementation(async (input) => {
      const toolName = input.externalTools[0].runtimeName
      await input.executeTool({ name: toolName, arguments: { query: '第一次' } })
      await input.executeTool({ name: toolName, arguments: { query: '第二次' } })
      return noChangeAgentResult(3)
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '搜索两次并总结')

    const promise = run.workflow.run()
    await vi.waitFor(() =>
      expect(run.workflow.runtimeState.value.status).toBe('waiting_authorizer'),
    )
    const request = run.workflow.runtimeState.value.authorizationRequest
    expect(request?.options).toContain('允许本次任务')
    expect(run.workflow.answerAuthorization(request?.id ?? '', '允许本次任务')).toBe(true)
    await promise

    expect(callMcpTool).toHaveBeenCalledTimes(2)
    expect(run.workflow.runtimeState.value.status).toBe('completed')
    expect(run.workflow.runtimeState.value.authorizationRequest).toBeNull()
  })

  it('auto-approves every tool from a trusted MCP server', async () => {
    listMcpTools.mockResolvedValue([mcpTool(true, false)])
    agentLoop.mockImplementation(async (input) => {
      await input.executeTool({
        name: input.externalTools[0].runtimeName,
        arguments: { action: 'trusted-operation' },
      })
      return noChangeAgentResult(2)
    })
    const settings = ref(createAiSettings('openai'))
    settings.value.model = 'test-model'
    const run = createRun(settings, snapshot(), async () => true, 'agent', '调用可信服务')

    await run.workflow.run()

    expect(callMcpTool).toHaveBeenCalledOnce()
    expect(run.workflow.runtimeState.value.status).toBe('completed')
    expect(run.workflow.runtimeState.value.authorizationRequest).toBeNull()
  })
})

describe('approved knowledge retrieval', () => {
  it('prioritizes accepted knowledge matching the current task', () => {
    const base = {
      objectType: 'claim' as const,
      status: 'approved' as const,
      structuredData: {},
      generatedRunId: null,
      cognitiveMode: 'research' as const,
      templateId: null,
      templateVersion: null,
      ownerId: null,
      scope: {},
      documentId: null,
      blockId: null,
      sourceRevision: null,
      authorityLevel: 'agent_candidate',
      confidence: null,
      validFrom: null,
      validUntil: null,
      verifiedAt: null,
      version: 1,
      createdAt: 1,
    }
    const selected = selectRelevantApprovedKnowledge(
      [
        { ...base, id: 'finance', title: '财务制度', content: '报销审批', updatedAt: 3 },
        {
          ...base,
          id: 'runtime',
          title: 'Agent 运行时约束',
          content: '工具权限与审计边界',
          updatedAt: 2,
        },
      ],
      '整理 Agent 运行时架构',
      1,
    )

    expect(selected[0]?.id).toBe('runtime')
  })
})

function mcpTool(serverTrusted: boolean, readOnly = true) {
  return {
    serverId: 'search-server',
    serverName: 'Search Server',
    name: 'search',
    description: 'Search the web',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    readOnly,
    serverTrusted,
  }
}

function noChangeAgentResult(rounds: number) {
  return {
    output: JSON.stringify({
      outcome: 'no_change',
      commands: [],
      patches: [],
      finalAnswer: '任务完成。',
    }),
    rounds,
    toolCalls: [],
  }
}

function message(id: string, role: 'user' | 'assistant', content: string): AiConversationMessage {
  return { id, role, mode: 'agent', content, status: 'done' }
}

function createRun(
  settings: Ref<AiSettings>,
  currentSnapshot: AgentRunDocumentSnapshot,
  ensureSecretLoaded: () => Promise<boolean>,
  mode: 'ask' | 'agent' | 'auto' = 'ask',
  initialPrompt = '总结当前文档',
  canonicalBlocks: DocumentBlock[] = [],
  cognitiveSessionService?: CognitiveSessionService,
) {
  const messages = ref<AiConversationMessage[]>([])
  const isRunning = ref(false)
  const prompt = ref(initialPrompt)
  const services: AgentRunServiceDependencies = {
    mcpClient: {
      listTools: listMcpTools,
      callTool: callMcpTool,
    } as unknown as McpClientPort,
    ...(cognitiveSessionService
      ? { getCognitiveSessionService: async () => cognitiveSessionService }
      : {}),
  }
  const workflow = useAgentRun({
    settings,
    mode: ref(mode),
    prompt,
    messages,
    error: ref(''),
    isRunning,
    tasks: ref([]),
    ensureSecretLoaded,
    createId: (() => {
      let index = 0
      return () => `id-${++index}`
    })(),
    replaceBlocksByRegex: async ({ blocks }) => blocks,
    notify: { success: vi.fn(), error: vi.fn() },
    services,
    ...(cognitiveSessionService
      ? {
          workspace: {
            projectId: ref('project-1'),
            projectName: ref('Project'),
            rootDocumentIds: ref<string[]>([]),
            conversationId: ref<string | null>('conversation-1'),
            ensureConversationId: () => 'conversation-1',
          },
        }
      : {}),
    document: {
      captureSnapshot: () => currentSnapshot,
      flushBeforeEdit: async () => ({ ok: true, revision: currentSnapshot.revision }),
      searchDocuments: async () => [],
      readDocument: async () => null,
      listDocumentBlocks: async () => canonicalBlocks,
    },
    patches: {
      pendingTask: ref(null),
      pendingPatchSet: ref(null),
      showModal: ref(false),
      getRepository: async () =>
        ({
          createTask: vi.fn(async (task) => ({ ok: true, value: task })),
          updateTask: vi.fn(async (task) => ({ ok: true, value: task })),
          recordToolCall: vi.fn(async (call) => ({ ok: true, value: call })),
          saveContextBundle: vi.fn(async (bundle) => ({ ok: true, value: bundle })),
        }) as unknown as AgentRepository,
      updateTaskPersistence: async () => undefined,
    },
  })
  return { workflow, messages, isRunning, prompt }
}

function attemptLearningTurn() {
  return {
    phase: 'waiting_user',
    feedback: {
      correctPoints: ['指出了微任务执行顺序'],
      omissions: ['没有说明渲染时机'],
      misconceptions: [],
    },
    understandingState: 'partial',
    evidence: '用户说明宏任务后会先清空微任务队列。',
    nextPrompt: { kind: 'guided_question', content: '渲染何时发生？', hintLevel: 0 },
    candidateUnderstanding: null,
  }
}

function createMemoryCognitiveSessionService(): {
  service: CognitiveSessionService
  current: () => CognitiveSession | null
} {
  let session: CognitiveSession | null = null
  const update = (
    status: CognitiveSession['status'],
    state: Record<string, unknown> | undefined,
  ) => {
    session = { ...session!, status, state: state ?? session!.state, version: session!.version + 1 }
    return Promise.resolve(ok(session))
  }
  const service = {
    start: vi.fn(async (input: CreateCognitiveSessionInput) => {
      session = {
        ...input,
        status: 'active',
        version: 1,
        createdAt: input.createdAt ?? 1,
        updatedAt: input.createdAt ?? 1,
      }
      return ok(session)
    }),
    listByConversation: vi.fn(async () => ok(session ? [session] : [])),
    resume: vi.fn(async () => update('active', undefined)),
    waitForUser: vi.fn(async (_id: string, _version: number, state: Record<string, unknown>) =>
      update('waiting_user', state),
    ),
    complete: vi.fn(async (_id: string, _version: number, state?: Record<string, unknown>) =>
      update('completed', state),
    ),
    cancel: vi.fn(async () => update('cancelled', undefined)),
  } as unknown as CognitiveSessionService
  return { service, current: () => session }
}

function snapshot(): AgentRunDocumentSnapshot {
  return {
    id: 'doc-1',
    title: '运行时文档',
    tags: ['测试'],
    sourceUrl: '',
    author: '',
    text: '运行开始正文',
    markdown: '运行开始正文\n',
    revision: 1,
    blocks: [{ id: 'block-1', type: 'paragraph', text: '运行开始正文', index: 0 }],
    selectedBlocks: [],
    hasBlockSelection: false,
    documents: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
