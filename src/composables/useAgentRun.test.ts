import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentRun, type AgentRunDocumentSnapshot } from './useAgentRun'
import type { AiConversationMessage } from './useAiConversation'
import { createAiSettings, type AiSettings } from '@/models/ai'
import type { AgentRepository } from '@/repositories/AgentRepository'

const completion = vi.hoisted(() => vi.fn())
const agentLoop = vi.hoisted(() => vi.fn())

vi.mock('@/services/AiMarkdownService', () => ({
  runAiMarkdownCompletion: completion,
}))
vi.mock('@/services/AgentRuntime', () => ({
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
      expect.objectContaining({ prompt: '创建页面', intent: 'create' }),
    )
    expect(run.messages.value[0]?.mode).toBe('agent')
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
})

function createRun(
  settings: Ref<AiSettings>,
  currentSnapshot: AgentRunDocumentSnapshot,
  ensureSecretLoaded: () => Promise<boolean>,
  mode: 'ask' | 'agent' | 'auto' = 'ask',
  initialPrompt = '总结当前文档',
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
    notify: { success: vi.fn(), error: vi.fn() },
    document: {
      captureSnapshot: () => currentSnapshot,
      flushBeforeEdit: async () => ({ ok: true, revision: currentSnapshot.revision }),
      searchDocuments: async () => [],
      readDocument: async () => null,
      listDocumentBlocks: async () => [],
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
