import type { SelectedBlock } from '@/models/agent/agent'
import type {
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolRequest,
} from '@/services/agent/AgentToolExecutor'
import {
  exportTiptapBlockToMarkdown,
  exportTiptapDocumentToMarkdown,
} from '@/editor/io/documentExport'
import {
  isRecord,
  normalizeRegexFlags,
  readLimit,
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
  readStringArray,
} from './toolArgumentParsers'

export function executeDocumentTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
  toolName: string,
): Promise<AgentToolExecutionResult> | AgentToolExecutionResult {
  switch (toolName) {
    case 'get_current_document':
      return { ok: true, value: projectCurrentDocumentAsMarkdown(context.currentDocument) }
    case 'get_selected_blocks':
      return { ok: true, value: context.selectedBlocks.map(projectBlockAsMarkdown) }
    case 'get_document_outline':
      return {
        ok: true,
        value: context.currentDocument.blocks
          .filter((block) => block.type === 'heading')
          .map((block) => ({ id: block.id, text: block.text, index: block.index })),
      }
    case 'search_documents':
      return executeSearchDocuments(request, context)
    case 'list_document_groups':
      return executeListDocumentGroups(request, context)
    case 'read_document':
      return executeReadDocument(request, context)
    case 'find_blocks_by_regex':
      return executeFindBlocksByRegex(request, context)
    default:
      return { ok: false, error: `文档工具 ${toolName} 未识别。` }
  }
}

async function executeSearchDocuments(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  const query = readRequiredString(request.arguments.query, 'query')
  const limit = readLimit(request.arguments.limit, 5)
  const scope = readSearchScope(request.arguments.scope, context.workspaceRootIds)
  if (context.executeNativeTool) {
    const value = await context.executeNativeTool(
      'search_documents',
      {
        query,
        limit,
        scope,
        workspaceRootIds: context.workspaceRootIds ?? [],
      },
      request.callId,
      request.signal,
    )
    context.onDocumentsDiscovered?.(readDocumentIds(value), scope)
    return { ok: true, value }
  }
  const documents = (await context.searchDocuments(query, limit)).filter(
    (document) =>
      scope === 'global' ||
      !context.workspaceDocumentIds?.length ||
      context.workspaceDocumentIds.includes(document.id),
  )
  context.onDocumentsDiscovered?.(
    documents.map((document) => document.id),
    scope,
  )
  return {
    ok: true,
    value: documents.map((document) => ({
      id: document.id,
      title: document.title,
      snippet: document.plainText.slice(0, 500),
      revision: document.revision,
    })),
  }
}

async function executeListDocumentGroups(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  if (!context.executeNativeTool) {
    return { ok: false, error: '当前环境未提供分组读取器。' }
  }
  const query = readOptionalString(request.arguments.query, 'query')
  return {
    ok: true,
    value: await context.executeNativeTool(
      'list_document_groups',
      { query },
      request.callId,
      request.signal,
    ),
  }
}

async function executeReadDocument(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  const documentId = readRequiredString(request.arguments.documentId, 'documentId')
  if (context.canReadDocument && !context.canReadDocument(documentId)) {
    return {
      ok: false,
      error:
        '目标文档不在当前项目工作区，也未由本次全库搜索发现。请先用 search_documents(scope="global") 扩大搜索范围。',
    }
  }
  const cursor = readOptionalInteger(request.arguments.cursor, 'cursor', 0, 1_000_000)
  const maxChars = readOptionalInteger(request.arguments.maxChars, 'maxChars', 4_096, 65_536)
  const blockIds = readStringArray(request.arguments.blockIds, 'blockIds', 100).filter(Boolean)
  if (context.executeNativeTool) {
    const document = await context.executeNativeTool(
      'read_document',
      {
        documentId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(maxChars === undefined ? {} : { maxChars }),
        ...(blockIds.length === 0 ? {} : { blockIds }),
      },
      request.callId,
      request.signal,
    )
    const enriched = prepareReadDocumentObservation(document)
    if (enriched) await context.onDocumentRead?.(documentId, enriched)
    return enriched
      ? { ok: true, value: enriched }
      : { ok: false, error: `文档 ${documentId} 不存在或不可读取。` }
  }
  const document = await context.readDocument(documentId)
  if (document) await context.onDocumentRead?.(documentId, document)
  return document
    ? {
        ok: true,
        value: {
          id: document.id,
          title: document.title,
          markdown: exportTiptapDocumentToMarkdown(document.contentJson).slice(0, 12_000),
          revision: document.revision,
          tags: document.tags,
        },
      }
    : { ok: false, error: `文档 ${documentId} 不存在或不可读取。` }
}

async function executeFindBlocksByRegex(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  const pattern = readRequiredString(request.arguments.pattern, 'pattern')
  if (pattern.length > 240) throw new Error('正则表达式不得超过 240 个字符。')
  const flags = normalizeRegexFlags(request.arguments.flags)
  if (!context.executeNativeTool) {
    return { ok: false, error: '当前环境未提供安全正则匹配器。' }
  }
  return {
    ok: true,
    value: await context.executeNativeTool(
      'find_blocks_by_regex',
      { pattern, flags, blocks: context.currentDocument.blocks },
      request.callId,
      request.signal,
    ),
  }
}

// --- Helpers ---

function readSearchScope(
  value: unknown,
  workspaceRootIds: string[] | undefined,
): 'workspace' | 'global' {
  if (value === undefined) return workspaceRootIds?.length ? 'workspace' : 'global'
  if (value === 'workspace' || value === 'global') return value
  throw new Error('工具参数 scope 必须是 workspace 或 global。')
}

function readDocumentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id : ''))
    .filter(Boolean)
}

function projectCurrentDocumentAsMarkdown(
  document: AgentToolExecutionContext['currentDocument'],
): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    markdown: document.markdown || document.text,
    blocks: document.blocks.map(projectBlockAsMarkdown),
  }
}

function projectBlockAsMarkdown(block: SelectedBlock): Record<string, unknown> {
  return {
    id: block.id,
    type: block.type,
    index: block.index,
    markdown: block.markdown || block.text,
  }
}

export function prepareReadDocumentObservation(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return value
  return {
    ...value,
    blocks: value.blocks.map((block) => {
      if (!isRecord(block) || !isRecord(block.contentJson)) return block
      const { contentJson, ...visibleBlock } = block
      return {
        ...visibleBlock,
        markdown: exportTiptapBlockToMarkdown(contentJson),
      }
    }),
  }
}
