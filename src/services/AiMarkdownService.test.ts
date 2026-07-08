import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AI_SETTINGS } from '@/models/ai'
import { runAiMarkdownCompletion } from './AiMarkdownService'

describe('AiMarkdownService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
})

function mockSuccessfulFetch(payload: unknown = { choices: [{ message: { content: 'ok' } }] }) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    body: null,
    json: async () => payload,
  })) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}
