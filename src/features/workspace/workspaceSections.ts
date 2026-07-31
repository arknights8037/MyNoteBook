import {
  AlertTriangle,
  Bot,
  BookOpenCheck,
  Boxes,
  Cable,
  CalendarClock,
  CirclePlay,
  Code2,
  Database,
  History,
  Inbox,
  Keyboard,
  Laptop,
  ListChecks,
  Mail,
  MessageCircle,
  Palette,
  Puzzle,
  Rss,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Type,
} from '@lucide/vue'
import type { Component } from 'vue'

export type WorkspaceSectionSurface =
  | 'inbox'
  | 'knowledge'
  | 'plugins'
  | 'automations'
  | 'audit'
  | 'settings'

export interface WorkspaceSectionMeta {
  id: string
  label: string
  description: string
  icon: Component
}

export const WORKSPACE_SECTIONS: Record<WorkspaceSectionSurface, WorkspaceSectionMeta[]> = {
  inbox: [
    { id: 'pending', label: '待处理', description: '需要阅读、判断或跟进', icon: Inbox },
    { id: 'all', label: '全部动态', description: '所有来源的统一时间线', icon: History },
    { id: 'rss', label: 'RSS', description: '订阅更新与增量内容', icon: Rss },
    { id: 'messages', label: '消息', description: 'IM 与协作工具消息', icon: MessageCircle },
    { id: 'email', label: '邮件', description: '邮件账户与会话', icon: Mail },
    { id: 'failures', label: '采集异常', description: '授权、同步与解析问题', icon: AlertTriangle },
  ],
  knowledge: [
    { id: 'assets', label: '知识资产', description: '文件与 AI 对话', icon: Database },
    { id: 'knowledge', label: '知识规则', description: '规则、决策和证据', icon: ShieldCheck },
    { id: 'views', label: '智能视图', description: '汇总与重组知识', icon: BookOpenCheck },
    { id: 'tasks', label: '任务验收', description: '结果与外部协作', icon: ListChecks },
  ],
  plugins: [
    { id: 'connections', label: '连接器', description: 'RSS、消息与邮件来源', icon: Cable },
    { id: 'environment', label: '本地环境', description: '设备、路径与工具链上下文', icon: Laptop },
    { id: 'skills', label: 'Skills', description: 'Agent 工作技能', icon: Code2 },
    { id: 'mcp', label: 'MCP Client', description: '连接工具与数据源', icon: Boxes },
    { id: 'mcp-server', label: 'MCP Server', description: '对外工具策略', icon: ServerCog },
    { id: 'builtin', label: '内置插件', description: '应用自带能力', icon: Puzzle },
  ],
  automations: [
    { id: 'tasks', label: '任务', description: '创建和管理自动化', icon: CalendarClock },
    { id: 'runs', label: '运行记录', description: '执行状态与结果', icon: CirclePlay },
  ],
  audit: [
    { id: 'all', label: '全部记录', description: '所有审计事件', icon: History },
    { id: 'agent_task', label: 'Agent 任务', description: '任务生命周期', icon: Bot },
    { id: 'tool_call', label: '工具调用', description: '工具执行记录', icon: Boxes },
    { id: 'confirmation', label: '确认事件', description: '用户确认操作', icon: ShieldCheck },
    {
      id: 'automation_run',
      label: '自动化运行',
      description: '定时与手动执行',
      icon: CalendarClock,
    },
    { id: 'task_run', label: '统一任务', description: '任务运行状态', icon: ListChecks },
    { id: 'knowledge', label: '知识对象', description: '知识写入与变更', icon: Database },
    { id: 'verification', label: '结果验证', description: '输出验收记录', icon: BookOpenCheck },
    { id: 'change_set', label: 'ChangeSet', description: '批量变更记录', icon: History },
    { id: 'approval', label: '审批', description: '审批决定记录', icon: ShieldCheck },
    { id: 'view_refresh', label: 'View 刷新', description: '视图刷新记录', icon: BookOpenCheck },
    { id: 'delegation', label: '外部委派', description: '跨 Agent 协作', icon: Bot },
    { id: 'domain_event', label: '领域事件', description: '领域状态变化', icon: History },
    { id: 'outbox', label: 'Outbox', description: '待分发事件', icon: Boxes },
  ],
  settings: [
    { id: 'general', label: '通用', description: '启动与新建行为', icon: SlidersHorizontal },
    { id: 'security', label: '安全', description: '敏感操作保护', icon: ShieldCheck },
    { id: 'appearance', label: '外观', description: '主题、字体与动效', icon: Palette },
    { id: 'editor', label: '编辑器', description: '排版、保存与块操作', icon: Type },
    { id: 'ai', label: 'AI', description: '模型、参数与提示词', icon: Bot },
    { id: 'data', label: '数据', description: '本地存储位置', icon: Database },
    { id: 'shortcuts', label: '快捷键', description: '常用操作按键', icon: Keyboard },
  ],
}

export function getWorkspaceSectionMeta(
  surface: WorkspaceSectionSurface,
  sectionId: string,
): WorkspaceSectionMeta {
  return (
    WORKSPACE_SECTIONS[surface].find((section) => section.id === sectionId) ??
    WORKSPACE_SECTIONS[surface][0]
  )
}
