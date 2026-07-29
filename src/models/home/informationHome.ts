export type InformationHomeWidgetType = 'email-actions' | 'rss-news' | 'agent-summary'

export interface InformationHomeGridPosition {
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

export interface InformationHomeWidget {
  id: string
  widgetType: InformationHomeWidgetType
  widgetVersion: 1
  query: { limit: number }
  settings: { title?: string }
  layout: {
    desktop: InformationHomeGridPosition
    compact?: InformationHomeGridPosition
  }
}

export interface InformationHomePayload {
  layoutVersion: 1
  widgets: InformationHomeWidget[]
}

export interface InformationHome {
  id: 'default'
  payload: InformationHomePayload
  schemaVersion: 1
  version: number
  autoSummaryEnabled: boolean
  summaryIntervalMinutes: number
  createdAt: number
  updatedAt: number
}

export interface InformationHomeSummary {
  id: string
  homeId: 'default'
  sourceCursorAt: number
  triggerSource: 'manual' | 'auto'
  status: 'completed' | 'failed'
  content: string
  provider: string
  model: string
  error: string | null
  generatedAt: number
}

export const INFORMATION_HOME_WIDGET_TYPES = new Set<InformationHomeWidgetType>([
  'email-actions',
  'rss-news',
  'agent-summary',
])

export function createDefaultInformationHomePayload(
  createId: (prefix: string) => string = (prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`,
): InformationHomePayload {
  return {
    layoutVersion: 1,
    widgets: [
      createWidget(createId, 'email-actions', { x: 0, y: 0, w: 5, h: 5, minW: 4, minH: 3 }),
      createWidget(createId, 'rss-news', { x: 5, y: 0, w: 7, h: 5, minW: 4, minH: 3 }),
      createWidget(createId, 'agent-summary', {
        x: 0,
        y: 5,
        w: 12,
        h: 4,
        minW: 6,
        minH: 3,
      }),
    ],
  }
}

export function createInformationHome(
  createId: (prefix: string) => string,
  now: number,
): InformationHome {
  return {
    id: 'default',
    payload: createDefaultInformationHomePayload(createId),
    schemaVersion: 1,
    version: 1,
    autoSummaryEnabled: false,
    summaryIntervalMinutes: 360,
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeInformationHomePayload(
  value: unknown,
  createId: (prefix: string) => string,
): InformationHomePayload {
  const fallback = createDefaultInformationHomePayload(createId)
  if (!isRecord(value) || value.layoutVersion !== 1 || !Array.isArray(value.widgets))
    return fallback
  const widgets = value.widgets
    .map((widget, index) => normalizeWidget(widget, index, createId))
    .filter((widget): widget is InformationHomeWidget => Boolean(widget))
    .slice(0, 20)
  return { layoutVersion: 1, widgets: widgets.length ? widgets : fallback.widgets }
}

export function validateInformationHomePayload(payload: InformationHomePayload): string | null {
  if (payload.layoutVersion !== 1) return '不支持此首页布局版本。'
  if (payload.widgets.length > 20) return '首页最多包含 20 个模块。'
  if (new Set(payload.widgets.map((widget) => widget.id)).size !== payload.widgets.length)
    return '首页模块 ID 不能重复。'
  for (const widget of payload.widgets) {
    if (!INFORMATION_HOME_WIDGET_TYPES.has(widget.widgetType)) return '首页包含未知模块。'
    if (!Number.isInteger(widget.query.limit) || widget.query.limit < 1 || widget.query.limit > 50)
      return '首页模块查询数量必须在 1 到 50 之间。'
    if ((widget.settings.title?.length ?? 0) > 80) return '首页模块标题不能超过 80 个字符。'
    for (const [position, columns] of [
      [widget.layout.desktop, 12],
      ...(widget.layout.compact ? [[widget.layout.compact, 6]] : []),
    ] as Array<[InformationHomeGridPosition, number]>) {
      if (![position.x, position.y, position.w, position.h].every(Number.isInteger))
        return '首页模块位置必须使用整数。'
      if (
        position.x < 0 ||
        position.y < 0 ||
        position.w < 1 ||
        position.h < 1 ||
        position.x + position.w > columns
      )
        return '首页模块位置超出网格范围。'
    }
  }
  return null
}

export function defaultWidgetSize(type: InformationHomeWidgetType) {
  if (type === 'email-actions') return { w: 5, h: 5, minW: 4, minH: 3 }
  if (type === 'rss-news') return { w: 7, h: 5, minW: 4, minH: 3 }
  return { w: 12, h: 4, minW: 6, minH: 3 }
}

function createWidget(
  createId: (prefix: string) => string,
  widgetType: InformationHomeWidgetType,
  desktop: InformationHomeGridPosition,
): InformationHomeWidget {
  return {
    id: createId('home-widget'),
    widgetType,
    widgetVersion: 1,
    query: { limit: widgetType === 'agent-summary' ? 1 : 8 },
    settings: {},
    layout: { desktop },
  }
}

function normalizeWidget(
  value: unknown,
  index: number,
  createId: (prefix: string) => string,
): InformationHomeWidget | null {
  if (
    !isRecord(value) ||
    !INFORMATION_HOME_WIDGET_TYPES.has(value.widgetType as InformationHomeWidgetType)
  )
    return null
  const widgetType = value.widgetType as InformationHomeWidgetType
  const size = defaultWidgetSize(widgetType)
  const query = isRecord(value.query) ? value.query : {}
  const settings = isRecord(value.settings) ? value.settings : {}
  const layout = isRecord(value.layout) ? value.layout : {}
  const defaultPosition = { x: 0, y: index * 4, ...size }
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : createId('home-widget'),
    widgetType,
    widgetVersion: 1,
    query: { limit: clampInteger(query.limit, 1, 50, widgetType === 'agent-summary' ? 1 : 8) },
    settings:
      typeof settings.title === 'string' && settings.title.trim()
        ? { title: settings.title.trim().slice(0, 80) }
        : {},
    layout: {
      desktop: normalizePosition(layout.desktop, defaultPosition, 12),
      ...(layout.compact
        ? {
            compact: normalizePosition(
              layout.compact,
              { ...defaultPosition, x: 0, w: Math.min(defaultPosition.w, 6) },
              6,
            ),
          }
        : {}),
    },
  }
}

function normalizePosition(
  value: unknown,
  fallback: InformationHomeGridPosition,
  columns: number,
): InformationHomeGridPosition {
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
