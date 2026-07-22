import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAiSettings, type AiProvider } from '@/models/ai/ai'
import { createDefaultExecutionPolicy } from '@/models/agent/executionPolicy'

vi.mock('@/services/ai/AiHttpService', () => ({
  proxyAiFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}))

import { runAgentToolLoop } from '@/services/agent/AgentRuntime'

const apiKey = process.env.MYNOTEBOOK_PROVIDER_SMOKE_API_KEY ?? ''
const provider = (process.env.MYNOTEBOOK_PROVIDER_SMOKE_PROVIDER ?? 'deepseek') as AiProvider
const endpoint = process.env.MYNOTEBOOK_PROVIDER_SMOKE_ENDPOINT ?? 'https://api.deepseek.com'
const model = process.env.MYNOTEBOOK_PROVIDER_SMOKE_MODEL ?? 'deepseek-v4-pro'
const enabled = apiKey.length > 0

describe.skipIf(!enabled)('real Provider G0 smoke', () => {
  const controllers: AbortController[] = []

  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.abort())
  })

  it('runs a real tool loop and produces a locally structured terminal result', async () => {
    const executed: string[] = []
    let sequence = 0
    const result = await runAgentToolLoop({
      taskId: 'g0-provider-tool-loop',
      prompt:
        '这是隔离的 G0 smoke。必须先且只调用 get_system_info 一次；看到 observation 后，用一句自然语言确认 nonce G0-PROVIDER-7319。不要读取或搜索任何文档。',
      context: '隔离上下文：nonce=G0-PROVIDER-7319；不包含用户文档。',
      settings: providerSettings(apiKey),
      systemPrompt:
        '你正在执行隔离稳定性测试。必须遵守工具调用要求，不得调用文档、搜索、写入或外部工具。',
      executionPolicy: createDefaultExecutionPolicy({
        tokenBudget: 800,
        allowedTools: ['get_system_info'],
        riskLevel: 'read_only',
      }),
      createId: () => `g0-provider-call-${++sequence}`,
      executeTool: async ({ name }) => {
        executed.push(name)
        return {
          ok: true,
          value: { os: 'isolated-smoke', architecture: 'test', nonce: 'G0-PROVIDER-7319' },
        }
      },
      recordToolCall: async () => undefined,
    })

    expect(executed).toEqual(['get_system_info'])
    expect(result.toolCalls).toHaveLength(1)
    expect(result.rounds).toBeGreaterThanOrEqual(2)
    const terminal = JSON.parse(result.output) as {
      outcome: string
      commands: unknown[]
      patches: unknown[]
      finalAnswer: string
    }
    expect(terminal.outcome).toBe('no_change')
    expect(terminal.commands).toEqual([])
    expect(terminal.patches).toEqual([])
    expect(terminal.finalAnswer).toContain('G0-PROVIDER-7319')
  }, 120_000)

  it('surfaces and sanitizes a real Provider authentication error', async () => {
    const invalidKey = 'g0-invalid-provider-key-should-never-appear'
    await expect(
      runAgentToolLoop({
        taskId: 'g0-provider-error',
        prompt: '返回固定文本 G0-ERROR。',
        context: '隔离错误路径。',
        settings: providerSettings(invalidKey),
        systemPrompt: '只执行隔离错误路径。',
        executionPolicy: createDefaultExecutionPolicy({
          tokenBudget: 64,
          allowedTools: [],
          riskLevel: 'read_only',
        }),
        createId: () => 'g0-provider-error-call',
        executeTool: async () => ({ ok: true }),
        recordToolCall: async () => undefined,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.length > 0 && !message.includes(invalidKey)
    })
  }, 60_000)

  it('cancels a real in-flight Provider request', async () => {
    const controller = new AbortController()
    controllers.push(controller)
    const running = runAgentToolLoop({
      taskId: 'g0-provider-cancel',
      prompt: '只写一篇很长的隔离测试说明，至少 3000 字，不调用任何工具。',
      context: '隔离取消路径，不包含用户文档。',
      settings: { ...providerSettings(apiKey), maxTokens: 4096 },
      systemPrompt: '这是取消测试。',
      signal: controller.signal,
      executionPolicy: {
        ...createDefaultExecutionPolicy({
          tokenBudget: 4096,
          allowedTools: [],
          riskLevel: 'read_only',
        }),
        maxDurationMs: 60_000,
      },
      createId: () => 'g0-provider-cancel-call',
      executeTool: async () => ({ ok: true }),
      recordToolCall: async () => undefined,
    })
    setTimeout(() => controller.abort(new DOMException('G0 smoke cancel', 'AbortError')), 100)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  }, 60_000)
})

function providerSettings(key: string) {
  const settings = createAiSettings(provider)
  settings.endpoint = endpoint
  settings.apiKey = key
  settings.model = model
  settings.maxTokens = 1024
  settings.reasoningEffort = 'auto'
  return settings
}
