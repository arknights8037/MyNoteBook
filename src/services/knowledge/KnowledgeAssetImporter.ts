import type { AiChatHistoryItem } from '@/models/ai/aiChatHistory'

export interface ExtractedKnowledgeAsset {
  title: string
  text: string
  format: string
  sourceType: 'office_file' | 'text_file'
}

export interface ImportedAiConversationFile {
  file: File
  originalPath: string
  title: string
  text: string
  markdownText: string
  conversationText: string | null
  format: string
  provider: string
  model: string
  messageCount: number
  availableModes: AiConversationImportMode[]
  defaultMode: AiConversationImportMode
}

export type AiConversationImportMode = 'conversation' | 'markdown'

export interface AiConversationImportSelection {
  candidate: ImportedAiConversationFile
  mode: AiConversationImportMode
}

export interface AiConversationImportBatch {
  conversations: ImportedAiConversationFile[]
  failures: string[]
}

const OFFICE_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'pptx'])
const MAX_FILE_SIZE = 50 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS = 5_000_000

export async function extractKnowledgeAssetFile(file: File): Promise<ExtractedKnowledgeAsset> {
  if (file.size > MAX_FILE_SIZE) throw new Error('单个知识资产不能超过 50 MB。')
  const extension = fileExtension(file.name)
  const title = file.name.replace(/\.[^.]+$/, '').trim() || '未命名知识资产'
  let text = ''

  if (extension === 'pdf') text = await extractPdf(file)
  else if (extension === 'docx') text = await extractDocx(file)
  else if (extension === 'xlsx' || extension === 'xls') text = await extractWorkbook(file)
  else if (extension === 'pptx') text = await extractPresentation(file)
  else if (extension === 'json') text = jsonFileToMarkdown(title, await readText(file))
  else if (extension === 'csv') text = await csvToMarkdown(title, await readText(file))
  else if (extension === 'txt') text = withMarkdownTitle(title, await readText(file))
  else if (extension === 'md' || extension === 'markdown') text = await readText(file)
  else throw new Error(`暂不支持 ${extension ? `.${extension}` : '该'} 文件格式。`)

  if (OFFICE_EXTENSIONS.has(extension)) text = `# ${title}\n\n${text}`
  const normalized = normalizeExtractedText(text)
  if (!normalized) throw new Error('文件中没有可提取的文本内容。')
  if (normalized.length > MAX_EXTRACTED_CHARACTERS)
    throw new Error('文件提取文本超过 500 万字符，请拆分后导入。')
  return {
    title,
    text: normalized,
    format: extension.toUpperCase(),
    sourceType: OFFICE_EXTENSIONS.has(extension) ? 'office_file' : 'text_file',
  }
}

export function aiConversationToKnowledgeAsset(
  conversation: AiChatHistoryItem,
): ExtractedKnowledgeAsset {
  const lines = [
    `# ${conversation.title}`,
    '',
    `> ${conversation.provider || 'AI'} · ${conversation.model || '未记录模型'} · ${conversation.messageCount} 条消息`,
    '',
  ]
  for (const message of conversation.messages) {
    lines.push(`## ${message.role === 'user' ? '用户' : 'AI 助手'}`, '', message.content.trim(), '')
  }
  return {
    title: conversation.title,
    text: lines.join('\n').trim(),
    format: 'AI CHAT',
    sourceType: 'text_file',
  }
}

export async function parseAiConversationImport(file: File): Promise<AiConversationImportBatch> {
  const extension = fileExtension(file.name)
  if (extension !== 'zip') {
    try {
      return { conversations: [await parseAiConversationFile(file)], failures: [] }
    } catch (error) {
      return { conversations: [], failures: [`${file.name}：${errorMessage(error)}`] }
    }
  }

  if (file.size > MAX_FILE_SIZE) throw new Error('AI 对话 ZIP 不能超过 50 MB。')
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(await readArrayBuffer(file))
  const entries = Object.values(archive.files).filter(
    (entry) =>
      !entry.dir &&
      /\.(?:md|markdown|json|txt)$/i.test(entry.name) &&
      !/(?:^|\/)__MACOSX\//.test(entry.name) &&
      !/(?:^|\/)\./.test(entry.name),
  )
  if (entries.length === 0) throw new Error('ZIP 中没有 Markdown、JSON 或 TXT 对话文件。')
  if (entries.length > 200) throw new Error('单个 ZIP 最多导入 200 个对话文件。')

  const conversations: ImportedAiConversationFile[] = []
  const failures: string[] = []
  let totalBytes = 0
  for (const entry of entries) {
    try {
      const bytes = await entry.async('uint8array')
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_FILE_SIZE) throw new Error('ZIP 解压后的对话文件总量超过 50 MB。')
      const name = entry.name.split('/').filter(Boolean).at(-1) ?? 'conversation.txt'
      const entryFile = new File([bytes], name, { type: mimeTypeForConversationFile(name) })
      const candidate = await parseAiConversationFile(entryFile, titleFromFileName(name))
      conversations.push({ ...candidate, originalPath: entry.name })
    } catch (error) {
      failures.push(`${entry.name}：${errorMessage(error)}`)
    }
  }
  return { conversations, failures }
}

async function parseAiConversationFile(
  file: File,
  titleOverride = '',
): Promise<ImportedAiConversationFile> {
  if (file.size > 10 * 1024 * 1024) throw new Error('单个对话文件不能超过 10 MB。')
  const extension = fileExtension(file.name)
  if (!['md', 'markdown', 'json', 'txt'].includes(extension)) {
    throw new Error('仅支持 Markdown、JSON 和 TXT。')
  }
  const raw = await readText(file)
  if (!raw.trim()) throw new Error('文件内容为空。')
  if (extension !== 'json') {
    const title = titleOverride || titleFromText(raw) || titleFromFileName(file.name)
    const roleMatches = raw.match(/^(?:#{1,3}\s*)?(?:用户|User|AI 助手|Assistant)\s*[:：]?\s*$/gim)
    return {
      file,
      originalPath: file.name,
      title,
      text: normalizeExtractedText(raw),
      markdownText: normalizeExtractedText(raw),
      conversationText: normalizeExtractedText(raw),
      format: extension === 'txt' ? 'AI CHAT · TXT' : 'AI CHAT · MARKDOWN',
      provider: '',
      model: '',
      messageCount: roleMatches?.length ?? 0,
      availableModes: ['conversation'],
      defaultMode: 'conversation',
    }
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('JSON 格式无效。')
  }
  const projected = projectConversationJson(value)
  const title = titleOverride || projected.title || titleFromFileName(file.name)
  const markdownText = jsonToMarkdown(title, value)
  const conversationText = projected.messages.length
    ? conversationMessagesToMarkdown(title, projected.messages, projected.provider, projected.model)
    : null
  return {
    file,
    originalPath: file.name,
    title,
    text: conversationText ?? markdownText,
    markdownText,
    conversationText,
    format: 'AI CHAT · JSON',
    provider: projected.provider,
    model: projected.model,
    messageCount: projected.messages.length,
    availableModes: conversationText ? ['conversation', 'markdown'] : ['markdown'],
    defaultMode: conversationText ? 'conversation' : 'markdown',
  }
}

export function materializeAiConversationImport(selection: AiConversationImportSelection): {
  title: string
  text: string
  format: string
  sourceType: 'ai_chat' | 'text_file'
  provider: string
  model: string
  messageCount: number
} {
  const { candidate, mode } = selection
  if (!candidate.availableModes.includes(mode)) throw new Error('所选 JSON 解析方式不可用。')
  if (mode === 'markdown') {
    return {
      title: candidate.title,
      text: candidate.markdownText,
      format: fileExtension(candidate.file.name) === 'json' ? 'JSON · MARKDOWN' : candidate.format,
      sourceType: 'text_file',
      provider: '',
      model: '',
      messageCount: 0,
    }
  }
  return {
    title: candidate.title,
    text: candidate.conversationText ?? candidate.text,
    format: candidate.format,
    sourceType: 'ai_chat',
    provider: candidate.provider,
    model: candidate.model,
    messageCount: candidate.messageCount,
  }
}

interface ProjectedMessage {
  role: 'user' | 'assistant'
  content: string
}

function projectConversationJson(value: unknown): {
  title: string
  provider: string
  model: string
  messages: ProjectedMessage[]
} {
  const record = asRecord(value)
  const candidates = collectMessageCandidates(value)

  const messages = candidates
    .map(projectMessage)
    .filter((message): message is ProjectedMessage => Boolean(message))
  return {
    title: findFirstStringField(value, ['title', 'name', 'conversation_name']),
    provider:
      stringField(record, ['provider', 'vendor']) ||
      firstCandidateField(candidates, ['provider', 'vendor', 'displayModel', 'model']),
    model:
      stringField(record, ['modelId', 'model_id', 'model_slug', 'model']) ||
      firstCandidateField(candidates, ['modelId', 'model_id', 'model_slug', 'model']),
    messages,
  }
}

function projectMessage(value: unknown): ProjectedMessage | null {
  const record = asRecord(value)
  if (!record) return null
  const author = asRecord(record.author)
  const rawRole = String(
    record.role ?? record.sender ?? record.speaker ?? record.from ?? author?.role ?? '',
  ).toLocaleLowerCase()
  const role =
    rawRole === 'user' || rawRole === 'human'
      ? 'user'
      : rawRole === 'assistant' || rawRole === 'ai' || rawRole === 'model' || rawRole === 'bot'
        ? 'assistant'
        : null
  if (!role) return null
  const contentRecord = asRecord(record.content)
  const rawContent =
    record.contents ??
    record.parts ??
    contentRecord?.parts ??
    record.text ??
    record.content ??
    record.message ??
    record.body
  const content = extractMessageText(rawContent)
  return content ? { role, content } : null
}

const MESSAGE_CONTAINER_FIELDS = [
  'messages',
  'chat_messages',
  'conversation',
  'conversations',
  'chats',
  'threads',
  'items',
  'data',
  'nodes',
  'children',
] as const

function collectMessageCandidates(value: unknown, depth = 0): unknown[] {
  if (depth > 5) return []
  if (Array.isArray(value)) {
    const direct = value.filter((item) => Boolean(projectMessage(item)))
    if (direct.length) return direct
    return value.flatMap((item) => collectMessageCandidates(item, depth + 1))
  }

  const record = asRecord(value)
  if (!record) return []
  if (projectMessage(record)) return [record]

  const mapping = asRecord(record.mapping)
  if (mapping) {
    const mapped = Object.values(mapping)
      .map((node) => asRecord(node)?.message)
      .filter((message) => Boolean(message))
    const direct = mapped.filter((message) => Boolean(projectMessage(message)))
    if (direct.length) return direct
  }

  for (const field of MESSAGE_CONTAINER_FIELDS) {
    if (record[field] === undefined) continue
    const nested = collectMessageCandidates(record[field], depth + 1)
    if (nested.length) return nested
  }
  return []
}

function extractMessageText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === 'string' ? part : stringField(asRecord(part), ['text', 'content']),
      )
      .filter(Boolean)
      .join('\n')
      .trim()
  return stringField(asRecord(value), ['text', 'content']).trim()
}

function firstCandidateField(candidates: unknown[], fields: string[]): string {
  for (const candidate of candidates) {
    const value = stringField(asRecord(candidate), fields)
    if (value) return value
  }
  return ''
}

function findFirstStringField(value: unknown, fields: string[], depth = 0): string {
  if (depth > 4) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringField(item, fields, depth + 1)
      if (found) return found
    }
    return ''
  }
  const record = asRecord(value)
  if (!record) return ''
  const direct = stringField(record, fields)
  if (direct) return direct
  for (const field of MESSAGE_CONTAINER_FIELDS) {
    if (record[field] === undefined) continue
    const found = findFirstStringField(record[field], fields, depth + 1)
    if (found) return found
  }
  return ''
}

function conversationMessagesToMarkdown(
  title: string,
  messages: ProjectedMessage[],
  provider: string,
  model: string,
): string {
  const metadata = [provider, model, `${messages.length} 条消息`].filter(Boolean).join(' · ')
  const lines = [`# ${title}`, '', ...(metadata ? [`> ${metadata}`, ''] : [])]
  for (const message of messages)
    lines.push(`## ${message.role === 'user' ? '用户' : 'AI 助手'}`, '', message.content, '')
  return lines.join('\n').trim()
}

export function jsonToMarkdown(title: string, value: unknown): string {
  const lines = [`# ${title}`, '']
  appendJsonMarkdown(lines, value, 2)
  return normalizeExtractedText(lines.join('\n'))
}

function jsonFileToMarkdown(fallbackTitle: string, raw: string): string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('JSON 格式无效。')
  }
  const title = findFirstStringField(value, ['title', 'name', 'conversation_name']) || fallbackTitle
  return jsonToMarkdown(title, value)
}

async function csvToMarkdown(title: string, raw: string): Promise<string> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(raw, { type: 'string' })
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? '']
  const rows = sheet
    ? (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][])
    : []
  return [`# ${title}`, '', markdownTable(rows)].filter(Boolean).join('\n')
}

function withMarkdownTitle(title: string, text: string): string {
  const normalized = normalizeExtractedText(text)
  return /^#{1,6}\s+/m.test(normalized) ? normalized : `# ${title}\n\n${normalized}`
}

function appendJsonMarkdown(lines: string[], value: unknown, level: number, label = ''): void {
  const headingLevel = Math.min(level, 4)
  if (Array.isArray(value)) {
    if (label) lines.push(`${'#'.repeat(headingLevel)} ${humanizeJsonKey(label)}`, '')
    if (value.length === 0) {
      lines.push('_空数组_', '')
      return
    }
    value.forEach((item, index) => {
      if (isScalar(item)) lines.push(`- ${formatJsonScalar(item)}`)
      else {
        lines.push(`${'#'.repeat(Math.min(headingLevel + 1, 4))} 条目 ${index + 1}`, '')
        appendJsonMarkdown(lines, item, headingLevel + 1)
      }
    })
    lines.push('')
    return
  }

  const record = asRecord(value)
  if (!record) {
    if (label) lines.push(`- **${humanizeJsonKey(label)}：** ${formatJsonScalar(value)}`)
    else lines.push(formatJsonScalar(value), '')
    return
  }
  if (label) lines.push(`${'#'.repeat(headingLevel)} ${humanizeJsonKey(label)}`, '')
  for (const [key, child] of Object.entries(record)) {
    if (isScalar(child)) lines.push(`- **${humanizeJsonKey(key)}：** ${formatJsonScalar(child)}`)
    else appendJsonMarkdown(lines, child, headingLevel + 1, key)
  }
  lines.push('')
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function formatJsonScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim() || '_空字符串_'
  return String(value)
}

function humanizeJsonKey(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim() || '未命名字段'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(record: Record<string, unknown> | null, fields: string[]): string {
  if (!record) return ''
  for (const field of fields)
    if (typeof record[field] === 'string') return String(record[field]).trim()
  return ''
}

function mimeTypeForConversationFile(name: string): string {
  const extension = fileExtension(name)
  if (extension === 'json') return 'application/json'
  if (extension === 'md' || extension === 'markdown') return 'text/markdown'
  return 'text/plain'
}

function titleFromText(value: string): string {
  const frontmatter = value.match(
    /^---\s*\n[\s\S]*?^title\s*:\s*["']?(.+?)["']?\s*$[\s\S]*?^---\s*$/im,
  )?.[1]
  if (frontmatter?.trim()) return frontmatter.trim()
  const heading = value.match(/^#\s+(.+)$/m)?.[1]
  if (heading?.trim()) return heading.trim()
  const labelled = value.match(/^(?:标题|Title)\s*[:：]\s*(.+)$/im)?.[1]
  return labelled?.trim() ?? ''
}

function titleFromFileName(name: string): string {
  const baseName = name.split(/[\\/]/).filter(Boolean).at(-1) ?? name
  let decoded = baseName
  try {
    decoded = decodeURIComponent(baseName)
  } catch {
    // Preserve non-URL-encoded filenames.
  }
  return decoded.replace(/\.(?:md|markdown|json|txt)$/i, '').trim() || '未命名对话'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function extractPdf(file: File): Promise<string> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const document = await pdfjs.getDocument({ data: new Uint8Array(await readArrayBuffer(file)) })
    .promise
  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  return pages.join('\n\n')
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ arrayBuffer: await readArrayBuffer(file) })
  return result.value
}

async function extractWorkbook(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await readArrayBuffer(file), { type: 'array' })
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name]
    const rows = sheet
      ? (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][])
      : []
    return `## ${name}\n\n${markdownTable(rows)}`
  }).join('\n\n')
}

function markdownTable(rows: unknown[][]): string {
  const width = Math.max(0, ...rows.map((row) => row.length))
  if (!width) return '_空表格_'
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => markdownTableCell(row[index])),
  )
  const header = normalized[0]!.map((cell, index) => cell || `列 ${index + 1}`)
  const body = normalized.slice(1)
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function markdownTableCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?|\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim()
}

async function extractPresentation(file: File): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(await readArrayBuffer(file))
  const slideNames = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  const slides: string[] = []
  for (const name of slideNames) {
    const xml = await archive.file(name)?.async('text')
    if (!xml) continue
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1]))
      .filter(Boolean)
      .join(' ')
    if (text) slides.push(`## 幻灯片 ${slideNumber(name)}\n${text}`)
  }
  return slides.join('\n\n')
}

function fileExtension(name: string): string {
  return name.split('.').at(-1)?.toLocaleLowerCase() ?? ''
}

function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml/i)?.[1] ?? 0)
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('无法读取文件内容。'))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('无法读取文件内容。')))
    reader.readAsArrayBuffer(file)
  })
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      resolve(typeof reader.result === 'string' ? reader.result : ''),
    )
    reader.addEventListener('error', () => reject(reader.error ?? new Error('无法读取文件内容。')))
    reader.readAsText(file)
  })
}
