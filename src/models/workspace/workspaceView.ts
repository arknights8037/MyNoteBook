import { createDefaultTableRows, normalizeTableRows } from '@/editor/blocks/structuredBlocks'
import { normalizeTableFields, type TableField } from '@/editor/blocks/tableFields'
import {
  convertLegacySlidesToSlidev,
  createDefaultSlidevSource,
  validateSlidevSource,
  type LegacySlidePage,
} from '@/models/workspace/slidevDeck'

export type StructuredWorkspaceViewType = 'slides' | 'uml' | 'table' | 'dashboard'

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

export type DashboardWidgetType = 'automation-results' | 'agent-work-status'

export interface DashboardGridPosition {
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

export interface DashboardWidgetInstance {
  id: string
  widgetType: DashboardWidgetType
  widgetVersion: 1
  query: {
    limit?: number
  }
  settings: {
    title?: string
    showCompleted?: boolean
  }
  layout: {
    desktop: DashboardGridPosition
    compact?: DashboardGridPosition
  }
}

export interface DashboardViewPayload {
  type: 'dashboard'
  scope: {
    kind: 'global' | 'project'
    projectId?: string
  }
  layoutVersion: 1
  widgets: DashboardWidgetInstance[]
}

export type StructuredWorkspaceViewPayload =
  | SlidesViewPayload
  | UmlViewPayload
  | TableViewPayload
  | DashboardViewPayload

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
    return {
      type,
      diagramType: 'flow',
      source: 'flowchart LR\n  start[开始] --> process[处理]\n  process --> done[完成]',
    }
  }
  if (type === 'dashboard') return createDefaultDashboardPayload(createId)
  const rows = createDefaultTableRows()
  return { type, rows, fields: normalizeTableFields([], rows) }
}

export function createDefaultDashboardPayload(
  createId: (prefix: string) => string = (prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`,
): DashboardViewPayload {
  return {
    type: 'dashboard',
    scope: { kind: 'global' },
    layoutVersion: 1,
    widgets: [
      {
        id: createId('dashboard-widget'),
        widgetType: 'automation-results',
        widgetVersion: 1,
        query: { limit: 8 },
        settings: {},
        layout: { desktop: { x: 0, y: 0, w: 7, h: 4, minW: 4, minH: 3 } },
      },
      {
        id: createId('dashboard-widget'),
        widgetType: 'agent-work-status',
        widgetVersion: 1,
        query: { limit: 8 },
        settings: { showCompleted: true },
        layout: { desktop: { x: 7, y: 0, w: 5, h: 4, minW: 4, minH: 3 } },
      },
    ],
  }
}

export function validateWorkspaceViewPayload(
  payload: StructuredWorkspaceViewPayload,
): string | null {
  if (payload.type === 'slides') {
    return validateSlidevSource(payload.source)
  }
  if (payload.type === 'uml') {
    if (!/^\s*(?:flowchart|graph)\s+(?:LR|RL|TB|BT)\b/m.test(payload.source))
      return '第一期 UML 只支持 Mermaid flowchart。'
    if (payload.source.length > 100_000) return 'Mermaid 源码过长。'
    return null
  }
  if (payload.type === 'dashboard') {
    if (payload.layoutVersion !== 1) return '暂不支持此信息面板布局版本。'
    if (payload.widgets.length > 30) return '信息面板最多包含 30 个组件。'
    if (new Set(payload.widgets.map((widget) => widget.id)).size !== payload.widgets.length) {
      return '信息面板组件 ID 不能重复。'
    }
    for (const widget of payload.widgets) {
      if (!widget.id.trim()) return '信息面板组件 ID 不能为空。'
      if (!DASHBOARD_WIDGET_TYPES.has(widget.widgetType)) return '信息面板包含未知组件。'
      if (widget.widgetVersion !== 1) return '信息面板包含不受支持的组件版本。'
      if (
        widget.query.limit !== undefined &&
        (!Number.isInteger(widget.query.limit) || widget.query.limit < 1 || widget.query.limit > 50)
      ) {
        return '信息面板组件查询数量必须在 1 到 50 之间。'
      }
      if ((widget.settings.title?.length ?? 0) > 80) return '信息面板组件标题不能超过 80 个字符。'
      const positions: Array<[DashboardGridPosition, number]> = [
        [widget.layout.desktop, 12],
        ...(widget.layout.compact ? [[widget.layout.compact, 6] as [DashboardGridPosition, number]] : []),
      ]
      for (const [position, columns] of positions) {
        if (![position.x, position.y, position.w, position.h].every(Number.isInteger)) {
          return '信息面板组件位置必须使用整数。'
        }
        if (position.x < 0 || position.y < 0 || position.w < 1 || position.h < 1) {
          return '信息面板组件位置无效。'
        }
        if (position.x + position.w > columns) return `信息面板组件超出 ${columns} 列网格。`
      }
    }
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
    return {
      ...payload,
      source: renameMermaidNode(payload.source, operation.nodeId, operation.label),
    }
  }
  if (operation.type === 'set_table_cell' && payload.type === 'table') {
    const rows = normalizeTableRows(payload.rows).map((row) => [...row])
    if (!rows[operation.row]?.[operation.column] && operation.value === undefined) return payload
    if (
      !rows[operation.row] ||
      operation.column < 0 ||
      operation.column >= rows[operation.row].length
    )
      throw new Error('表格单元格不存在。')
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
  if (type === 'dashboard') return normalizeDashboardPayload(payload, createId)
  return value as StructuredWorkspaceViewPayload
}

const DASHBOARD_WIDGET_TYPES = new Set<DashboardWidgetType>([
  'automation-results',
  'agent-work-status',
])

function normalizeDashboardPayload(
  value: Record<string, unknown>,
  createId: (prefix: string) => string,
): DashboardViewPayload {
  const defaultPayload = createDefaultDashboardPayload(createId)
  const scopeValue = isRecord(value.scope) ? value.scope : {}
  const scopeKind = scopeValue.kind === 'project' ? 'project' : 'global'
  const widgets = Array.isArray(value.widgets)
    ? value.widgets
        .map((widget, index) => normalizeDashboardWidget(widget, index, createId))
        .filter((widget): widget is DashboardWidgetInstance => Boolean(widget))
        .slice(0, 30)
    : defaultPayload.widgets
  return {
    type: 'dashboard',
    scope: {
      kind: scopeKind,
      ...(scopeKind === 'project' && typeof scopeValue.projectId === 'string'
        ? { projectId: scopeValue.projectId }
        : {}),
    },
    layoutVersion: 1,
    widgets,
  }
}

function normalizeDashboardWidget(
  value: unknown,
  index: number,
  createId: (prefix: string) => string,
): DashboardWidgetInstance | null {
  if (!isRecord(value) || !DASHBOARD_WIDGET_TYPES.has(value.widgetType as DashboardWidgetType)) {
    return null
  }
  const widgetType = value.widgetType as DashboardWidgetType
  const query = isRecord(value.query) ? value.query : {}
  const settings = isRecord(value.settings) ? value.settings : {}
  const layout = isRecord(value.layout) ? value.layout : {}
  const defaults =
    widgetType === 'automation-results'
      ? { x: 0, y: index * 4, w: 7, h: 4, minW: 4, minH: 3 }
      : { x: 7, y: index * 4, w: 5, h: 4, minW: 4, minH: 3 }
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : createId('dashboard-widget'),
    widgetType,
    widgetVersion: 1,
    query: { limit: clampInteger(query.limit, 1, 50, 8) },
    settings: {
      ...(typeof settings.title === 'string' && settings.title.trim()
        ? { title: settings.title.trim().slice(0, 80) }
        : {}),
      ...(typeof settings.showCompleted === 'boolean'
        ? { showCompleted: settings.showCompleted }
        : {}),
    },
    layout: {
      desktop: normalizeGridPosition(layout.desktop, defaults),
      ...(layout.compact
        ? {
            compact: normalizeGridPosition(
              layout.compact,
              { ...defaults, x: 0, w: Math.min(defaults.w, 6), minW: Math.min(defaults.minW, 6) },
              6,
            ),
          }
        : {}),
    },
  }
}

function normalizeGridPosition(
  value: unknown,
  fallback: DashboardGridPosition,
  columns = 12,
): DashboardGridPosition {
  const position = isRecord(value) ? value : {}
  const w = clampInteger(position.w, 1, columns, fallback.w)
  return {
    x: clampInteger(position.x, 0, columns - w, Math.min(fallback.x, columns - w)),
    y: clampInteger(position.y, 0, 10_000, fallback.y),
    w,
    h: clampInteger(position.h, 1, 20, fallback.h),
    minW: clampInteger(position.minW, 1, w, fallback.minW ?? 1),
    minH: clampInteger(position.minH, 1, 20, fallback.minH ?? 1),
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(Math.round(value), max))
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export interface MermaidSemanticNode {
  id: string
  label: string
}

export function parseMermaidFlowNodes(source: string): MermaidSemanticNode[] {
  const nodes = new Map<string, MermaidSemanticNode>()
  const pattern =
    /\b([A-Za-z_][\w-]*)\s*(\[\[|\[\(|\(\(|\{\{|\[|\(|\{)([^\n]*?)(\]\]|\)\]|\)\)|\}\}|\]|\)|\})/g
  for (const match of source.matchAll(pattern)) {
    nodes.set(match[1], { id: match[1], label: match[3].trim() })
  }
  return [...nodes.values()]
}

export function renameMermaidNode(source: string, nodeId: string, label: string): string {
  if (!label.trim()) throw new Error('节点内容不能为空。')
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(\\b${escaped}\\s*(?:\\[\\[|\\[\\(|\\(\\(|\\{\\{|\\[|\\(|\\{))([^\\n]*?)(\\]\\]|\\)\\]|\\)\\)|\\}\\}|\\]|\\)|\\})`,
  )
  if (!pattern.test(source))
    throw new Error(`Mermaid 节点 ${nodeId} 不存在或使用了暂不支持的语法。`)
  return source.replace(pattern, `$1${label.trim()}$3`)
}
