import type { SelectedBlock } from '@/models/agent'
import type { DocumentRecord, DocumentSummary } from '@/models/document'
import { getAgentToolDefinition } from './AgentToolRegistry'

export interface AgentToolRequest {
  name: string
  arguments: Record<string, unknown>
}

export interface AgentToolExecutionContext {
  currentDocument: {
    id: string
    title: string
    revision: number | null
    text: string
    blocks: SelectedBlock[]
  }
  selectedBlocks: SelectedBlock[]
  searchDocuments: (query: string, limit: number) => Promise<DocumentSummary[]>
  readDocument: (documentId: string) => Promise<DocumentRecord | null>
  executeNativeTool?: (
    name: 'search_documents' | 'read_document',
    args: Record<string, unknown>,
  ) => Promise<unknown>
}

export interface AgentToolExecutionResult {
  ok: boolean
  value?: unknown
  error?: string
}

export async function executeAgentTool(
  request: AgentToolRequest,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  const definition = getAgentToolDefinition(request.name)
  if (!definition) return { ok: false, error: `工具 ${request.name} 不在白名单中。` }
  if (definition.risk === 'write') {
    return { ok: false, error: `写工具 ${request.name} 只能在最终 commands/Patches 中提出，不能在 loop 中直接执行。` }
  }

  try {
    switch (definition.name) {
      case 'get_current_document':
        return { ok: true, value: context.currentDocument }
      case 'get_selected_blocks':
        return { ok: true, value: context.selectedBlocks }
      case 'get_document_outline':
        return {
          ok: true,
          value: context.currentDocument.blocks
            .filter((block) => block.type === 'heading')
            .map((block) => ({ id: block.id, text: block.text, index: block.index })),
        }
      case 'search_documents': {
        const query = readRequiredString(request.arguments.query, 'query')
        const limit = readLimit(request.arguments.limit, 5)
        if (context.executeNativeTool) {
          return {
            ok: true,
            value: await context.executeNativeTool('search_documents', { query, limit }),
          }
        }
        const documents = await context.searchDocuments(query, limit)
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
      case 'read_document': {
        const documentId = readRequiredString(request.arguments.documentId, 'documentId')
        if (context.executeNativeTool) {
          const document = await context.executeNativeTool('read_document', { documentId })
          return document
            ? { ok: true, value: document }
            : { ok: false, error: `文档 ${documentId} 不存在或不可读取。` }
        }
        const document = await context.readDocument(documentId)
        return document
          ? {
              ok: true,
              value: {
                id: document.id,
                title: document.title,
                plainText: document.plainText.slice(0, 12_000),
                revision: document.revision,
                tags: document.tags,
              },
            }
          : { ok: false, error: `文档 ${documentId} 不存在或不可读取。` }
      }
      case 'find_blocks_by_regex': {
        const pattern = readRequiredString(request.arguments.pattern, 'pattern')
        if (pattern.length > 240) throw new Error('正则表达式不得超过 240 个字符。')
        const flags = normalizeRegexFlags(request.arguments.flags)
        const expression = new RegExp(pattern, flags)
        return {
          ok: true,
          value: context.currentDocument.blocks.filter((block) => {
            expression.lastIndex = 0
            return expression.test(block.text)
          }),
        }
      }
      default:
        return { ok: false, error: `工具 ${definition.name} 尚未接入执行器。` }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`工具参数 ${field} 不能为空。`)
  return value.trim()
}

function readLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.round(value), 10))
    : fallback
}

function normalizeRegexFlags(value: unknown): string {
  const flags = typeof value === 'string' ? value.replace(/[^gim]/g, '') : ''
  return Array.from(new Set(flags.split(''))).join('')
}
