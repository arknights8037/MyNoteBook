import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AI_SETTINGS } from '@/models/ai'
import { runAiMarkdownCompletion } from './AiMarkdownService'

const proxyRequest = vi.hoisted(() => vi.fn())

vi.mock('./AiHttpService', () => ({
  proxyAiFetch: proxyRequest,
}))

describe('AiMarkdownService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    proxyRequest.mockReset()
  })

  it('sends reasoning effort only for reasoning-capable models', async () => {
    const fetchMock = mockSuccessfulFetch()

    await runAiMarkdownCompletion({
      prompt: '整理',
      context: '',
      settings: { ...DEFAULT_AI_SETTINGS, model: 'gpt-5-mini', reasoningEffort: 'high' },
      onDelta: vi.fn(),
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('high')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
  })

  it('omits reasoning effort for non-reasoning models', async () => {
    const fetchMock = mockSuccessfulFetch()

    await runAiMarkdownCompletion({
      prompt: '整理',
      context: '',
      settings: { ...DEFAULT_AI_SETTINGS, model: 'gpt-4.1-mini', reasoningEffort: 'high' },
      onDelta: vi.fn(),
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('routes Anthropic providers to the messages API shape', async () => {
    const fetchMock = mockSuccessfulFetch({
      content: [{ type: 'text', text: 'ok' }],
    })

    await runAiMarkdownCompletion({
      prompt: '整理',
      context: '',
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-5',
        reasoningEffort: 'medium',
      },
      onDelta: vi.fn(),
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages')
    const request = fetchMock.mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>
    expect(request?.headers).toMatchObject({ 'anthropic-version': '2023-06-01' })
    expect(body).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: DEFAULT_AI_SETTINGS.systemPrompt,
      max_tokens: DEFAULT_AI_SETTINGS.maxTokens,
    })
    expect(body.thinking).toMatchObject({ type: 'enabled' })
  })

  it('reads the final OpenAI-compatible streaming frame when it has no trailing newline', async () => {
    mockStreamingFetch([
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
    ])
    const onDelta = vi.fn()

    await expect(
      runAiMarkdownCompletion({
        prompt: '整理',
        context: '',
        settings: { ...DEFAULT_AI_SETTINGS, provider: 'openai-compatible' },
        onDelta,
      }),
    ).resolves.toBe('hello')

    expect(onDelta).toHaveBeenNthCalledWith(1, 'hel', 'content')
    expect(onDelta).toHaveBeenNthCalledWith(2, 'lo', 'content')
  })

  it('streams OpenAI-compatible reasoning content separately from final content', async () => {
    mockStreamingFetch([
      'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"结论"}}]}',
    ])
    const onDelta = vi.fn()

    await expect(
      runAiMarkdownCompletion({
        prompt: '整理',
        context: '',
        settings: { ...DEFAULT_AI_SETTINGS, provider: 'deepseek' },
        onDelta,
      }),
    ).resolves.toBe('结论')

    expect(onDelta).toHaveBeenNthCalledWith(1, '先分析', 'reasoning')
    expect(onDelta).toHaveBeenNthCalledWith(2, '结论', 'content')
  })

  it('reads the final Anthropic streaming frame when it has no trailing newline', async () => {
    mockStreamingFetch([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}',
    ])
    const onDelta = vi.fn()

    await expect(
      runAiMarkdownCompletion({
        prompt: '整理',
        context: '',
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: 'anthropic',
          endpoint: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-5',
        },
        onDelta,
      }),
    ).resolves.toBe('hello')

    expect(onDelta).toHaveBeenNthCalledWith(1, 'he', 'content')
    expect(onDelta).toHaveBeenNthCalledWith(2, 'llo', 'content')
  })

  it('streams Anthropic thinking separately from text output', async () => {
    mockStreamingFetch([
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"思考"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}',
    ])
    const onDelta = vi.fn()

    await expect(
      runAiMarkdownCompletion({
        prompt: '整理',
        context: '',
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: 'anthropic',
          endpoint: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-5',
        },
        onDelta,
      }),
    ).resolves.toBe('正文')

    expect(onDelta).toHaveBeenNthCalledWith(1, '思考', 'reasoning')
    expect(onDelta).toHaveBeenNthCalledWith(2, '正文', 'content')
  })

  it('does not send Anthropic thinking when max tokens cannot leave a thinking budget', async () => {
    const fetchMock = mockSuccessfulFetch({
      content: [{ type: 'text', text: 'ok' }],
    })

    await runAiMarkdownCompletion({
      prompt: '整理',
      context: '',
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-5',
        maxTokens: 1,
        reasoningEffort: 'medium',
      },
      onDelta: vi.fn(),
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('thinking')
  })
})

function mockSuccessfulFetch(payload: unknown = { choices: [{ message: { content: 'ok' } }] }) {
  proxyRequest.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    }),
  )
  return proxyRequest
}

function mockStreamingFetch(chunks: string[]) {
  const encoder = new globalThis.TextEncoder()
  const body = new globalThis.ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  proxyRequest.mockResolvedValue(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  )
  return proxyRequest
}
