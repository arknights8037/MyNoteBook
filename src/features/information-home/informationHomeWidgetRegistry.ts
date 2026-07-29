import type { InformationHomeWidgetType } from '@/models/home/informationHome'

export interface InformationHomeWidgetDefinition {
  type: InformationHomeWidgetType
  title: string
  description: string
  source: string
  defaultSize: { w: number; h: number; minW: number; minH: number }
}

export const INFORMATION_HOME_WIDGET_REGISTRY: readonly InformationHomeWidgetDefinition[] = [
  {
    type: 'email-actions',
    title: '邮件事项',
    description: '聚合仍待处理的邮件、发件人和到达时间。',
    source: '本地邮件收件箱',
    defaultSize: { w: 5, h: 5, minW: 4, minH: 3 },
  },
  {
    type: 'rss-news',
    title: 'RSS 新闻',
    description: '按发布时间查看多个来源的最新文章。',
    source: '本地 RSS 收件箱',
    defaultSize: { w: 7, h: 5, minW: 4, minH: 3 },
  },
  {
    type: 'agent-summary',
    title: 'Agent 信息摘要',
    description: '将当前邮件事项和 RSS 新闻整理成只读行动摘要。',
    source: '本地信号 + 当前 AI Provider',
    defaultSize: { w: 12, h: 4, minW: 6, minH: 3 },
  },
] as const

export function getInformationHomeWidgetDefinition(type: InformationHomeWidgetType) {
  const definition = INFORMATION_HOME_WIDGET_REGISTRY.find((item) => item.type === type)
  if (!definition) throw new Error(`未注册的首页模块：${type}`)
  return definition
}
