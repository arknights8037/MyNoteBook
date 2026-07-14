import type { AiRunInput } from '@/models/ai'
import { proxyAiFetch } from './AiHttpService'
import { resolveProviderCapabilities } from '@/models/providerCapabilities'

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
    }
    message?: {
      content?: string
      reasoning_content?: string
    }
  }>
}

interface AiStreamDelta {
  content: string
  reasoning: string
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
      { role: 'system', content: input.systemPrompt ?? input.settings.systemPrompt },
      {
        role: 'user',
        content: buildUserPrompt(input.prompt, input.context, input.outputMode),
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

  const response = await proxyAiFetch(endpoint, {
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

  if (!isStreamingResponse(response)) {
    const data = (await response.json()) as ChatCompletionChunk
    const content = data.choices?.[0]?.message?.content ?? ''
    const reasoning = data.choices?.[0]?.message?.reasoning_content ?? ''
    if (reasoning) input.onDelta(reasoning, 'reasoning')
    if (content) input.onDelta(content, 'content')
    return content
  }

  return readStreamingResponse(response, input.onDelta)
}

function getReasoningEffort(input: AiRunInput): 'low' | 'medium' | 'high' | null {
  const effort = input.settings.reasoningEffort
  if (effort === 'auto') return null
  return resolveProviderCapabilities(input.settings.provider, input.settings.model).reasoningEffort
    ? effort
    : null
}

function supportsSamplingParameters(input: AiRunInput): boolean {
  const capabilities = resolveProviderCapabilities(input.settings.provider, input.settings.model)
  return capabilities.temperature && capabilities.topP
}

async function runAnthropicMessagesCompletion(input: AiRunInput): Promise<string> {
  const endpoint = input.settings.endpoint.replace(/\/+$/, '') + '/messages'
  const requestBody: Record<string, unknown> = {
    model: input.settings.model,
    max_tokens: input.settings.maxTokens,
    temperature: input.settings.temperature,
    top_p: input.settings.topP,
    stream: true,
    system: input.systemPrompt ?? input.settings.systemPrompt,
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(input.prompt, input.context, input.outputMode),
      },
    ],
  }
  const thinking = getAnthropicThinking(input)
  if (thinking) requestBody.thinking = thinking

  const response = await proxyAiFetch(endpoint, {
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

  if (!isStreamingResponse(response)) {
    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>
    }
    const content = data.content?.find((part) => part.type === 'text')?.text ?? ''
    const reasoning = data.content?.find((part) => part.type === 'thinking')?.thinking ?? ''
    if (reasoning) input.onDelta(reasoning, 'reasoning')
    if (content) input.onDelta(content, 'content')
    return content
  }

  return readAnthropicStreamingResponse(response, input.onDelta)
}

function getAnthropicThinking(input: AiRunInput): Record<string, unknown> | null {
  if (input.settings.reasoningEffort === 'auto') return null
  if (input.settings.maxTokens <= 1) return null
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

function buildUserPrompt(
  prompt: string,
  context: string,
  outputMode: AiRunInput['outputMode'] = 'markdown',
): string {
  const parts = ['用户任务：', prompt.trim()]
  if (context.trim()) {
    parts.push('', '当前文档上下文：', context.trim())
  }
  parts.push(
    '',
    outputMode === 'agent-json'
      ? '请严格按系统中的 Agent 协议输出单个 JSON 对象，不要使用 Markdown 围栏。'
      : '请只输出 Markdown 正文，不要包裹额外解释。',
  )
  return parts.join('\n')
}

async function readStreamingResponse(
  response: Response,
  onDelta: (delta: string, channel?: 'content' | 'reasoning') => void,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new globalThis.TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const delta = parseStreamingDataLine(line, parseDelta)
      if (delta.reasoning) {
        onDelta(delta.reasoning, 'reasoning')
      }
      if (delta.content) {
        fullText += delta.content
        onDelta(delta.content, 'content')
      }
    }
  }

  const finalDelta = parseStreamingDataLine(buffer, parseDelta)
  if (finalDelta.reasoning) {
    onDelta(finalDelta.reasoning, 'reasoning')
  }
  if (finalDelta.content) {
    fullText += finalDelta.content
    onDelta(finalDelta.content, 'content')
  }

  return fullText
}

function parseDelta(payload: string): AiStreamDelta {
  try {
    const parsed = JSON.parse(payload) as ChatCompletionChunk
    return {
      content: parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '',
      reasoning:
        parsed.choices?.[0]?.delta?.reasoning_content ??
        parsed.choices?.[0]?.message?.reasoning_content ??
        '',
    }
  } catch {
    return { content: '', reasoning: '' }
  }
}

async function readAnthropicStreamingResponse(
  response: Response,
  onDelta: (delta: string, channel?: 'content' | 'reasoning') => void,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new globalThis.TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const delta = parseStreamingDataLine(line, parseAnthropicDelta)
      if (delta.reasoning) {
        onDelta(delta.reasoning, 'reasoning')
      }
      if (delta.content) {
        fullText += delta.content
        onDelta(delta.content, 'content')
      }
    }
  }

  const finalDelta = parseStreamingDataLine(buffer, parseAnthropicDelta)
  if (finalDelta.reasoning) {
    onDelta(finalDelta.reasoning, 'reasoning')
  }
  if (finalDelta.content) {
    fullText += finalDelta.content
    onDelta(finalDelta.content, 'content')
  }

  return fullText
}

function parseStreamingDataLine(
  line: string,
  parsePayload: (payload: string) => AiStreamDelta,
): AiStreamDelta {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return { content: '', reasoning: '' }
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') return { content: '', reasoning: '' }
  return parsePayload(payload)
}

function isStreamingResponse(response: Response): boolean {
  return Boolean(response.body) && response.headers.get('content-type')?.includes('text/event-stream')
}

function parseAnthropicDelta(payload: string): AiStreamDelta {
  try {
    const parsed = JSON.parse(payload) as {
      type?: string
      delta?: {
        type?: string
        text?: string
        thinking?: string
      }
    }
    if (parsed.type !== 'content_block_delta') return { content: '', reasoning: '' }
    if (parsed.delta?.type === 'thinking_delta') {
      return { content: '', reasoning: parsed.delta.thinking ?? '' }
    }
    return {
      content: parsed.delta?.type === 'text_delta' ? (parsed.delta.text ?? '') : '',
      reasoning: '',
    }
  } catch {
    return { content: '', reasoning: '' }
  }
}
