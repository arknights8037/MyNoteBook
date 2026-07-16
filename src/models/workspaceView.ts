import { createDefaultTableRows, normalizeTableRows } from '@/editor/structuredBlocks'
import { normalizeTableFields, type TableField } from '@/editor/tableFields'

export type StructuredWorkspaceViewType = 'slides' | 'uml' | 'table'
export type SlideTemplateId = 'cover' | 'section' | 'title-content' | 'two-column' | 'big-number' | 'quote' | 'summary'

export interface SlidePage {
  id: string
  templateId: SlideTemplateId
  slots: Record<string, string | string[]>
  background: 'plain' | 'dark' | 'gradient'
}

export interface SlidesViewPayload {
  type: 'slides'
  pages: SlidePage[]
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
  version: number
  createdAt: number
  updatedAt: number
}

export type WorkspaceViewOperation =
  | { type: 'replace_payload'; payload: StructuredWorkspaceViewPayload }
  | { type: 'rename_mermaid_node'; nodeId: string; label: string }
  | { type: 'set_table_cell'; row: number; column: number; value: string }
  | { type: 'set_slide_slot'; pageId: string; slot: string; value: string | string[] }

export function createDefaultWorkspaceViewPayload(
  type: StructuredWorkspaceViewType,
  createId: (prefix: string) => string,
): StructuredWorkspaceViewPayload {
  if (type === 'slides') {
    return {
      type,
      pages: [{ id: createId('slide'), templateId: 'cover', slots: { title: '新幻灯片', subtitle: '填写副标题' }, background: 'gradient' }],
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
    if (!payload.pages.length) return '幻灯片至少需要一页。'
    if (payload.pages.length > 200) return '幻灯片不能超过 200 页。'
    if (new Set(payload.pages.map((page) => page.id)).size !== payload.pages.length) return '幻灯片页面 ID 重复。'
    return null
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
  if (operation.type === 'set_slide_slot' && payload.type === 'slides') {
    if (!payload.pages.some((page) => page.id === operation.pageId)) throw new Error('幻灯片页面不存在。')
    return { ...payload, pages: payload.pages.map((page) => page.id === operation.pageId ? { ...page, slots: { ...page.slots, [operation.slot]: operation.value } } : page) }
  }
  throw new Error('操作与目标视图类型不匹配。')
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
