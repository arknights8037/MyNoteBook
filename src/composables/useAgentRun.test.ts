import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentRun, type AgentRunDocumentSnapshot } from './useAgentRun'
import type { AiConversationMessage } from './useAiConversation'
import { createAiSettings, type AiSettings } from '@/models/ai'
import type { AgentRepository } from '@/repositories/AgentRepository'

const completion = vi.hoisted(() => vi.fn())

vi.mock('@/services/AiMarkdownService', () => ({
  runAiMarkdownCompletion: completion,
}))

describe('useAgentRun', () => {
  beforeEach(() => {
    completion.mockReset()
    completion.mockImplementation(async (input) => {
      input.onDelta('冻结上下文回答')
      return '冻结上下文回答'
    })
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
  })
})

function createRun(
  settings: Ref<AiSettings>,
  currentSnapshot: AgentRunDocumentSnapshot,
  ensureSecretLoaded: () => Promise<boolean>,
) {
  const messages = ref<AiConversationMessage[]>([])
  const isRunning = ref(false)
  const workflow = useAgentRun({
    settings,
    mode: ref('ask'),
    prompt: ref('总结当前文档'),
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
      getRepository: async () => ({}) as AgentRepository,
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
