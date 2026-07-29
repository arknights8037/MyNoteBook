import type { DashboardWidgetType } from '@/models/workspace/workspaceView'

export interface DashboardWidgetDefinition {
  type: DashboardWidgetType
  title: string
  description: string
  source: string
  permission: 'automation.read' | 'agent.read'
  defaultSize: { w: number; h: number; minW: number; minH: number }
}

export const DASHBOARD_WIDGET_REGISTRY: readonly DashboardWidgetDefinition[] = [
  {
    type: 'automation-results',
    title: '自动化结果',
    description: '汇总最近的自动化运行结果与异常。',
    source: '自动化运行记录',
    permission: 'automation.read',
    defaultSize: { w: 7, h: 4, minW: 4, minH: 3 },
  },
  {
    type: 'agent-work-status',
    title: 'Agent 工作状态',
    description: '查看当前 Agent 任务的进度与等待项。',
    source: '本地 Agent 任务',
    permission: 'agent.read',
    defaultSize: { w: 5, h: 4, minW: 4, minH: 3 },
  },
] as const

export function getDashboardWidgetDefinition(type: DashboardWidgetType): DashboardWidgetDefinition {
  const definition = DASHBOARD_WIDGET_REGISTRY.find((item) => item.type === type)
  if (!definition) throw new Error(`未注册的信息面板组件：${type}`)
  return definition
}
