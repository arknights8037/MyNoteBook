import type { AiSettings } from '@/models/ai'

interface ModelsResponse {
  data?: Array<{ id?: string; name?: string; display_name?: string }>
  models?: Array<string | { id?: string; name?: string; display_name?: string }>
}

export async function fetchAiModelOptions(settings: AiSettings): Promise<string[]> {
  const endpoint = settings.endpoint.replace(/\/+$/, '') + '/models'
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: createModelListHeaders(settings),
  })

  if (!response.ok) {
    throw new Error('获取模型失败：' + response.status + ' ' + (await response.text()))
  }

  const payload = (await response.json()) as ModelsResponse
  const models = [
    ...(payload.data ?? []).map(readModelId),
    ...(payload.models ?? []).map(readModelId),
  ].filter(Boolean)

  const uniqueModels = Array.from(new Set(models))
  if (uniqueModels.length === 0) {
    throw new Error('目标端点没有返回可识别的模型列表。')
  }

  return uniqueModels.sort((a, b) => a.localeCompare(b))
}

function createModelListHeaders(settings: AiSettings): Record<string, string> {
  if (settings.provider === 'anthropic') {
    return {
      'anthropic-version': '2023-06-01',
      ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
    }
  }

  return {
    ...(settings.apiKey ? { Authorization: 'Bearer ' + settings.apiKey } : {}),
  }
}

function readModelId(
  model: string | { id?: string; name?: string; display_name?: string },
): string {
  if (typeof model === 'string') return model.trim()
  return (model.id ?? model.name ?? model.display_name ?? '').trim()
}
