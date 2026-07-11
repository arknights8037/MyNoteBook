import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AI_SETTINGS } from '@/models/ai'
import { fetchAiModelOptions } from './AiModelService'

describe('AiModelService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches OpenAI-compatible model ids from the target endpoint', async () => {
    const fetchMock = mockModelsFetch({
      data: [{ id: 'z-model' }, { id: 'a-model' }],
    })

    await expect(
      fetchAiModelOptions({
        ...DEFAULT_AI_SETTINGS,
        endpoint: 'https://example.com/v1/',
        apiKey: 'key',
      }),
    ).resolves.toEqual(['a-model', 'z-model'])

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/v1/models')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer key',
    })
  })

  it('uses Anthropic headers for Anthropic model discovery', async () => {
    const fetchMock = mockModelsFetch({
      data: [{ id: 'claude-sonnet' }],
    })

    await fetchAiModelOptions({
      ...DEFAULT_AI_SETTINGS,
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/models')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'anthropic-key',
    })
  })

  it('reports unrecognized model payloads', async () => {
    mockModelsFetch({ data: [] })

    await expect(fetchAiModelOptions(DEFAULT_AI_SETTINGS)).rejects.toThrow(
      '没有返回可识别的模型列表',
    )
  })
})

function mockModelsFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  })) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}
