export type CreateViewKind = 'document' | 'flowchart' | 'slides' | 'plan'

export interface CreateViewOption {
  id: CreateViewKind
  title: string
  description: string
}

export interface CreateViewTemplate {
  title: string
  markdown: string
}

export const CREATE_VIEW_OPTIONS: readonly CreateViewOption[] = [
  {
    id: 'document',
    title: '文档',
    description: '自由编排文字、表格与多媒体内容',
  },
  {
    id: 'flowchart',
    title: '流程图',
    description: '用 Mermaid 描述流程与系统关系',
  },
  {
    id: 'slides',
    title: '幻灯片',
    description: '按页面组织提纲、讲稿与视觉提示',
  },
  {
    id: 'plan',
    title: '计划表单',
    description: '跟踪目标、任务、负责人和进度',
  },
]

export const CREATE_VIEW_TEMPLATES: Readonly<Record<CreateViewKind, CreateViewTemplate>> = {
  document: {
    title: '新文档',
    markdown: '# 新文档\n\n开始记录内容。',
  },
  flowchart: {
    title: '新流程图',
    markdown: '# 新流程图\n\n```mermaid\nflowchart LR\n  A[开始] --> B[处理]\n  B --> C[完成]\n```',
  },
  slides: {
    title: '新幻灯片',
    markdown:
      '# 新幻灯片\n\n## 第 1 页：标题\n\n填写核心观点。\n\n---\n\n## 第 2 页：内容\n\n- 要点一\n- 要点二',
  },
  plan: {
    title: '新计划',
    markdown:
      '# 新计划\n\n## 目标\n\n描述计划目标。\n\n## 任务\n\n- [ ] 定义范围\n- [ ] 安排负责人\n- [ ] 跟踪进度',
  },
}
