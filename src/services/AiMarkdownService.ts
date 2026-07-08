import type { AiRunInput } from '@/models/ai'

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
    }
    message?: {
      content?: string
    }
  }>
}

export async function runAiMarkdownCompletion(input: AiRunInput): Promise<string> {
  if (input.settings.provider === 'anthropic') {
    return runAnthropicMessagesCompletion(input)
  }
  return runChatCompletions(input)
}

async function runChatCompletions(input: AiRunInput): Promise<string> {
  const endpoint = input.settings.endpoint.replace(/\/+$/, '') + '/chat/completions'
  const requestBody: Record<string, unknown> = {
    model: input.settings.model,
    stream: true,
    messages: [
      { role: 'system', content: input.settings.systemPrompt },
      {
        role: 'user',
        content: buildUserPrompt(input.prompt, input.context),
      },
    ],
  }
  if (supportsSamplingParameters(input)) {
    requestBody.temperature = input.settings.temperature
    requestBody.top_p = input.settings.topP
  }
  const maxTokenField =
    input.settings.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'
  requestBody[maxTokenField] = input.settings.maxTokens
  const reasoningEffort = getReasoningEffort(input)
  if (reasoningEffort) {
    requestBody.reasoning_effort = reasoningEffort
  }
  if (input.settings.provider === 'qwen' && input.settings.reasoningEffort === 'auto') {
    requestBody.enable_thinking = false
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(input.settings.apiKey ? { Authorization: 'Bearer ' + input.settings.apiKey } : {}),
    },
    body: JSON.stringify(requestBody),
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error('AI 请求失败：' + response.status + ' ' + (await response.text()))
  }

  if (!response.body) {
    const data = (await response.json()) as ChatCompletionChunk
    const content = data.choices?.[0]?.message?.content ?? ''
    input.onDelta(content)
    return content
  }

  return readStreamingResponse(response, input.onDelta)
}

function getReasoningEffort(input: AiRunInput): 'low' | 'medium' | 'high' | null {
  const effort = input.settings.reasoningEffort
  if (effort === 'auto') return null
  if (input.settings.provider === 'qwen' || input.settings.provider === 'deepseek') return effort
  if (!supportsReasoningEffort(input.settings.model)) return null
  return effort
}

function supportsReasoningEffort(model: string): boolean {
  return /^(o\d|o-|gpt-5)/i.test(model.trim())
}

function supportsSamplingParameters(input: AiRunInput): boolean {
  return input.settings.provider !== 'openai' || !supportsReasoningEffort(input.settings.model)
}

async function runAnthropicMessagesCompletion(input: AiRunInput): Promise<string> {
  const endpoint = input.settings.endpoint.replace(/\/+$/, '') + '/messages'
  const requestBody: Record<string, unknown> = {
    model: input.settings.model,
    max_tokens: input.settings.maxTokens,
    temperature: input.settings.temperature,
    top_p: input.settings.topP,
    stream: true,
    system: input.settings.systemPrompt,
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(input.prompt, input.context),
      },
    ],
  }
  const thinking = getAnthropicThinking(input)
  if (thinking) requestBody.thinking = thinking

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(input.settings.apiKey ? { 'x-api-key': input.settings.apiKey } : {}),
    },
    body: JSON.stringify(requestBody),
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error('AI 请求失败：' + response.status + ' ' + (await response.text()))
  }

  if (!response.body) {
    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>
    }
    const content = data.content?.find((part) => part.type === 'text')?.text ?? ''
    input.onDelta(content)
    return content
  }

  return readAnthropicStreamingResponse(response, input.onDelta)
}

function getAnthropicThinking(input: AiRunInput): Record<string, unknown> | null {
  if (input.settings.reasoningEffort === 'auto') return null
  const budgetTokens = {
    low: 1024,
    medium: 4096,
    high: 8192,
  }[input.settings.reasoningEffort]
  return {
    type: 'enabled',
    budget_tokens: Math.max(1, Math.min(input.settings.maxTokens - 1, budgetTokens)),
  }
}

function buildUserPrompt(prompt: string, context: string): string {
  const parts = ['用户任务：', prompt.trim()]
  if (context.trim()) {
    parts.push('', '当前文档上下文：', context.trim())
  }
  parts.push('', '请只输出 Markdown 正文，不要包裹额外解释。')
  return parts.join('\n')
}

async function readStreamingResponse(
  response: Response,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      const delta = parseDelta(payload)
      if (!delta) continue
      fullText += delta
      onDelta(delta)
    }
  }

  return fullText
}

function parseDelta(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as ChatCompletionChunk
    return parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? ''
  } catch {
    return ''
  }
}

async function readAnthropicStreamingResponse(
  response: Response,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      const delta = parseAnthropicDelta(payload)
      if (!delta) continue
      fullText += delta
      onDelta(delta)
    }
  }

  return fullText
}

function parseAnthropicDelta(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      type?: string
      delta?: {
        type?: string
        text?: string
      }
    }
    if (parsed.type !== 'content_block_delta') return ''
    return parsed.delta?.type === 'text_delta' ? (parsed.delta.text ?? '') : ''
  } catch {
    return ''
  }
}
