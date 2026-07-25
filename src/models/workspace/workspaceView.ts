import { createDefaultTableRows, normalizeTableRows } from '@/editor/blocks/structuredBlocks'
import { normalizeTableFields, type TableField } from '@/editor/blocks/tableFields'
import {
  convertLegacySlidesToSlidev,
  createDefaultSlidevSource,
  validateSlidevSource,
  type LegacySlidePage,
} from '@/models/workspace/slidevDeck'

export type StructuredWorkspaceViewType = 'slides' | 'uml' | 'table'

export interface SlidesViewPayload {
  type: 'slides'
  format: 'slidev'
  source: string
  assetIds: string[]
}

export interface UmlViewPayload {
  type: 'uml'
  diagramType: 'flow'
  source: string
}

export interface TableViewPayload {
  type: 'table'
  rows: string[][]
  fields: TableField[]
}

export type StructuredWorkspaceViewPayload = SlidesViewPayload | UmlViewPayload | TableViewPayload

export interface StructuredWorkspaceView {
  id: string
  parentId: string | null
  sortOrder: number
  viewType: StructuredWorkspaceViewType
  title: string
  pinnedAt: number | null
  payload: StructuredWorkspaceViewPayload
  schemaVersion: 1
  version: number
  createdAt: number
  updatedAt: number
}

export interface StructuredWorkspaceViewSummary {
  id: string
  parentId: string | null
  sortOrder: number
  viewType: StructuredWorkspaceViewType
  title: string
  pinnedAt: number | null
  version: number
  createdAt: number
  updatedAt: number
}

export type WorkspaceViewOperation =
  | { type: 'replace_payload'; payload: StructuredWorkspaceViewPayload }
  | { type: 'rename_mermaid_node'; nodeId: string; label: string }
  | { type: 'set_table_cell'; row: number; column: number; value: string }
  | { type: 'set_slidev_source'; source: string }

export function createDefaultWorkspaceViewPayload(
  type: StructuredWorkspaceViewType,
  createId: (prefix: string) => string,
): StructuredWorkspaceViewPayload {
  if (type === 'slides') {
    return {
      type,
      format: 'slidev',
      source: createDefaultSlidevSource(createId),
      assetIds: [],
    }
  }
  if (type === 'uml') {
    return { type, diagramType: 'flow', source: 'flowchart LR\n  start[开始] --> process[处理]\n  process --> done[完成]' }
  }
  const rows = createDefaultTableRows()
  return { type, rows, fields: normalizeTableFields([], rows) }
}

export function validateWorkspaceViewPayload(payload: StructuredWorkspaceViewPayload): string | null {
  if (payload.type === 'slides') {
    return validateSlidevSource(payload.source)
  }
  if (payload.type === 'uml') {
    if (!/^\s*(?:flowchart|graph)\s+(?:LR|RL|TB|BT)\b/m.test(payload.source)) return '第一期 UML 只支持 Mermaid flowchart。'
    if (payload.source.length > 100_000) return 'Mermaid 源码过长。'
    return null
  }
  const rows = normalizeTableRows(payload.rows)
  if (rows.length > 10_000) return '表格不能超过 10000 行。'
  if ((rows[0]?.length ?? 0) > 500) return '表格不能超过 500 列。'
  return null
}

export function applyWorkspaceViewOperation(
  payload: StructuredWorkspaceViewPayload,
  operation: WorkspaceViewOperation,
): StructuredWorkspaceViewPayload {
  if (operation.type === 'replace_payload') return operation.payload
  if (operation.type === 'rename_mermaid_node' && payload.type === 'uml') {
    return { ...payload, source: renameMermaidNode(payload.source, operation.nodeId, operation.label) }
  }
  if (operation.type === 'set_table_cell' && payload.type === 'table') {
    const rows = normalizeTableRows(payload.rows).map((row) => [...row])
    if (!rows[operation.row]?.[operation.column] && operation.value === undefined) return payload
    if (!rows[operation.row] || operation.column < 0 || operation.column >= rows[operation.row].length) throw new Error('表格单元格不存在。')
    rows[operation.row][operation.column] = operation.value
    return { ...payload, rows, fields: normalizeTableFields(payload.fields, rows) }
  }
  if (operation.type === 'set_slidev_source' && payload.type === 'slides') {
    return { ...payload, source: operation.source }
  }
  throw new Error('操作与目标视图类型不匹配。')
}

export function normalizeWorkspaceViewPayload(
  type: StructuredWorkspaceViewType,
  value: unknown,
  createId: (prefix: string) => string = (prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`,
): StructuredWorkspaceViewPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createDefaultWorkspaceViewPayload(type, createId)
  }
  const payload = value as Record<string, unknown>
  if (type === 'slides') {
    if (payload.format === 'slidev' && typeof payload.source === 'string') {
      return {
        type: 'slides',
        format: 'slidev',
        source: payload.source,
        assetIds: Array.isArray(payload.assetIds)
          ? payload.assetIds.filter((id): id is string => typeof id === 'string')
          : [],
      }
    }
    const pages = Array.isArray(payload.pages) ? (payload.pages as LegacySlidePage[]) : []
    return {
      type: 'slides',
      format: 'slidev',
      source: convertLegacySlidesToSlidev(pages, createId),
      assetIds: [],
    }
  }
  return value as StructuredWorkspaceViewPayload
}

export interface MermaidSemanticNode { id: string; label: string }

export function parseMermaidFlowNodes(source: string): MermaidSemanticNode[] {
  const nodes = new Map<string, MermaidSemanticNode>()
  const pattern = /\b([A-Za-z_][\w-]*)\s*(\[\[|\[\(|\(\(|\{\{|\[|\(|\{)([^\n]*?)(\]\]|\)\]|\)\)|\}\}|\]|\)|\})/g
  for (const match of source.matchAll(pattern)) {
    nodes.set(match[1], { id: match[1], label: match[3].trim() })
  }
  return [...nodes.values()]
}

export function renameMermaidNode(source: string, nodeId: string, label: string): string {
  if (!label.trim()) throw new Error('节点内容不能为空。')
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(\\b${escaped}\\s*(?:\\[\\[|\\[\\(|\\(\\(|\\{\\{|\\[|\\(|\\{))([^\\n]*?)(\\]\\]|\\)\\]|\\)\\)|\\}\\}|\\]|\\)|\\})`)
  if (!pattern.test(source)) throw new Error(`Mermaid 节点 ${nodeId} 不存在或使用了暂不支持的语法。`)
  return source.replace(pattern, `$1${label.trim()}$3`)
}
