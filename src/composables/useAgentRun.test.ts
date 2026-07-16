import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentRun, type AgentRunDocumentSnapshot } from './useAgentRun'
import type { AiConversationMessage } from './useAiConversation'
import { createAiSettings, type AiSettings } from '@/models/ai'
import type { AgentRepository } from '@/repositories/AgentRepository'
import type { DocumentBlock } from '@/models/documentBlock'

const completion = vi.hoisted(() => vi.fn())
const agentLoop = vi.hoisted(() => vi.fn())
const listMcpTools = vi.hoisted(() => vi.fn())
const callMcpTool = vi.hoisted(() => vi.fn())

vi.mock('@/services/AiMarkdownService', () => ({
  runAiMarkdownCompletion: completion,
}))
vi.mock('@/services/AgentRuntime', () => ({
  runAgentToolLoop: agentLoop,
}))
vi.mock('@/services/McpService', () => ({
  listMcpTools,
  callMcpTool,
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
    agentLoop.mockResolvedValue(noChangeAgentResult(2))
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

function createRun(
  settings: Ref<AiSettings>,
  currentSnapshot: AgentRunDocumentSnapshot,
  ensureSecretLoaded: () => Promise<boolean>,
  mode: 'ask' | 'agent' | 'auto' = 'ask',
  initialPrompt = '总结当前文档',
  canonicalBlocks: DocumentBlock[] = [],
) {
  const messages = ref<AiConversationMessage[]>([])
  const isRunning = ref(false)
  const workflow = useAgentRun({
    settings,
    mode: ref(mode),
    prompt: ref(initialPrompt),
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
  return { workflow, messages, isRunning }
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
