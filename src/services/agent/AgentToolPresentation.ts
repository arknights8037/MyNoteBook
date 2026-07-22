import type { AgentToolCall } from '@/models/agent/agentTool'

export interface AgentToolDisplayField {
  label: string
  value: string
}

export interface AgentToolDisplayItem {
  title: string
  description: string
  url: string | null
  documentId: string | null
  blockId: string | null
}

export interface AgentToolPresentation {
  inputFields: AgentToolDisplayField[]
  resultItems: AgentToolDisplayItem[]
  resultText: string
  resultCount: number | null
}

const FIELD_LABELS: Record<string, string> = {
  query: '搜索内容',
  documentId: '文档',
  uri: '资源地址',
  url: '地址',
  command: '命令',
  pattern: '匹配规则',
  name: '名称',
  serverId: 'MCP 服务',
  toolName: '工具',
  relativePath: '文件',
  scope: '范围',
  limit: '数量上限',
  markdown: '原文 Markdown',
  content: '内容',
  before: '修改前内容',
  after: '修改后内容',
  instructions: '完整指令',
}

export function presentAgentToolCall(toolCall: AgentToolCall): AgentToolPresentation {
  const input = parseAgentToolPayload(toolCall.argumentsJson)
  const result = parseAgentToolPayload(toolCall.resultJson)
  const resultItems = collectDisplayItems(result)
  return {
    inputFields: projectInputFields(input),
    resultItems,
    resultText: extractResultText(result),
    resultCount: inferResultCount(result, resultItems),
  }
}

export function parseAgentToolPayload(value: string | null): unknown {
  if (!value) return null
  try {
    return unwrapMcpPayload(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}

function unwrapMcpPayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return value
  const blocks = value.content
    .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
  if (blocks.length === 0) return value
  if (blocks.length > 1) return blocks.map(parseTextPayload)
  return parseTextPayload(blocks[0]!)
}

function parseTextPayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function projectInputFields(value: unknown): AgentToolDisplayField[] {
  if (!isRecord(value)) return []
  const preferred = Object.keys(FIELD_LABELS).filter((key) => value[key] !== undefined)
  const remaining = Object.keys(value)
    .filter((key) => !preferred.includes(key))
    .slice(0, 5)
  return [...preferred, ...remaining]
    .map((key) => ({ label: FIELD_LABELS[key] ?? key, value: formatFieldValue(value[key]) }))
    .filter((field) => field.value)
}

function collectDisplayItems(value: unknown): AgentToolDisplayItem[] {
  const candidates = findResultCollection(value)
  if (!candidates) return []
  return candidates
    .slice(0, 12)
    .map(projectDisplayItem)
    .filter((item) => item.title || item.url)
}

function findResultCollection(value: unknown, depth = 0): unknown[] | null {
  if (depth > 4) return null
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return null
  for (const key of ['results', 'items', 'documents', 'resources', 'tools', 'data']) {
    if (Array.isArray(value[key])) return value[key]
  }
  for (const nested of Object.values(value)) {
    const found = findResultCollection(nested, depth + 1)
    if (found) return found
  }
  return null
}

function projectDisplayItem(value: unknown): AgentToolDisplayItem {
  if (typeof value === 'string')
    return {
      title: compactText(value, 160),
      description: '',
      url: null,
      documentId: null,
      blockId: null,
    }
  if (!isRecord(value)) {
    return {
      title: formatFieldValue(value),
      description: '',
      url: null,
      documentId: null,
      blockId: null,
    }
  }
  const url = firstString(value.url, value.href, value.link, value.sourceUrl, value.uri)
  const explicitDocumentId = firstString(value.documentId, value.document_id)
  const documentId = explicitDocumentId || (!isHttpUrl(url) ? firstString(value.id) : '')
  const blockId = firstString(value.blockId, value.block_id)
  const title = firstString(value.title, value.name, value.documentTitle, value.label, url)
  const description = firstString(
    value.summary,
    value.description,
    value.snippet,
    value.contentSnippet,
    value.text,
    value.content,
  )
  return {
    title: compactText(title || '未命名结果', 180),
    description: compactText(description, 320),
    url: isHttpUrl(url) ? url : null,
    documentId: documentId || null,
    blockId: blockId || null,
  }
}

function extractResultText(value: unknown): string {
  if (typeof value === 'string') return compactText(value, 1_200)
  if (!isRecord(value)) return ''
  for (const key of ['summary', 'message', 'output', 'stdout', 'text']) {
    if (typeof value[key] === 'string') return compactText(value[key], 1_200)
  }
  if (value.proposalCaptured === true) return '修改提案已进入确认队列。'
  if (value.created === true) return '草稿已创建，可前往对应管理页审阅。'
  return ''
}

function inferResultCount(value: unknown, items: AgentToolDisplayItem[]): number | null {
  if (items.length > 0) return items.length
  if (Array.isArray(value)) return value.length
  return null
}

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return compactText(value, 500)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(formatFieldValue).filter(Boolean).join('、')
  if (value === null || value === undefined) return ''
  return compactText(JSON.stringify(value), 500)
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized
}

function firstString(...values: unknown[]): string {
  return (
    values.find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? ''
  )
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
