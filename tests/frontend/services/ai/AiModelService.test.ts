import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AI_SETTINGS } from '@/models/ai/ai'
import { invoke } from '@tauri-apps/api/core'
import { loadAiApiKey } from '@/services/ai/AiSecretService'
import { fetchAiModelOptions } from '@/services/ai/AiModelService'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/services/ai/AiSecretService', () => ({
  loadAiApiKey: vi.fn(),
}))

describe('AiModelService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(loadAiApiKey).mockReset().mockResolvedValue('')
    vi.mocked(invoke).mockReset()
  })

  it('fetches OpenAI-compatible model ids from the target endpoint', async () => {
    const invokeMock = mockModelsRequest({
      data: [{ id: 'z-model' }, { id: 'a-model' }],
    })

    await expect(
      fetchAiModelOptions({
        ...DEFAULT_AI_SETTINGS,
        endpoint: 'https://example.com/v1/',
        apiKey: 'key',
      }),
    ).resolves.toEqual(['a-model', 'z-model'])

    expect(invokeMock).toHaveBeenCalledWith('fetch_ai_models', {
      input: {
        endpoint: 'https://example.com/v1/',
        provider: 'openai',
        apiKey: 'key',
      },
    })
  })

  it('uses Anthropic headers for Anthropic model discovery', async () => {
    const invokeMock = mockModelsRequest({
      data: [{ id: 'claude-sonnet' }],
    })

    await fetchAiModelOptions({
      ...DEFAULT_AI_SETTINGS,
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
    })

    expect(invokeMock).toHaveBeenCalledWith('fetch_ai_models', {
      input: {
        endpoint: 'https://api.anthropic.com/v1',
        provider: 'anthropic',
        apiKey: 'anthropic-key',
      },
    })
  })

  it('loads the provider key before fetching model groups when settings are not hydrated yet', async () => {
    vi.mocked(loadAiApiKey).mockResolvedValue('stored-provider-key')
    const invokeMock = mockModelsRequest({ data: [{ id: 'group-model' }] })

    await fetchAiModelOptions({
      ...DEFAULT_AI_SETTINGS,
      provider: 'openai-compatible',
      endpoint: 'https://example.com/v1',
      apiKey: '',
    })

    expect(loadAiApiKey).toHaveBeenCalledWith('openai-compatible')
    expect(invokeMock).toHaveBeenCalledWith('fetch_ai_models', {
      input: {
        endpoint: 'https://example.com/v1',
        provider: 'openai-compatible',
        apiKey: 'stored-provider-key',
      },
    })
  })

  it('does not read the secret store when the current settings already contain a key', async () => {
    mockModelsRequest({ data: [{ id: 'model' }] })

    await fetchAiModelOptions({
      ...DEFAULT_AI_SETTINGS,
      apiKey: ' current-key ',
    })

    expect(loadAiApiKey).not.toHaveBeenCalled()
  })

  it('reports unrecognized model payloads', async () => {
    mockModelsRequest({ data: [] })

    await expect(fetchAiModelOptions(DEFAULT_AI_SETTINGS)).rejects.toThrow(
      '没有返回可识别的模型列表',
    )
  })
})

function mockModelsRequest(payload: unknown) {
  const invokeMock = vi.mocked(invoke)
  invokeMock.mockResolvedValue(payload)
  return invokeMock
}
