export type CreateViewKind = 'document' | 'slides' | 'uml' | 'table' | 'mindmap'

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
    id: 'uml',
    title: 'UML / 流程图',
    description: '使用受限 Mermaid 和语义节点编辑关系',
  },
  {
    id: 'mindmap',
    title: '思维导图',
    description: '用可编辑节点组织主题、层级和关系',
  },
  {
    id: 'slides',
    title: '幻灯片',
    description: '按页面组织提纲、讲稿与视觉提示',
  },
  {
    id: 'table',
    title: '表格',
    description: '复用文档表格字段、行列和编辑能力',
  },
]

export const CREATE_VIEW_TEMPLATES: Readonly<
  Record<Extract<CreateViewKind, 'document'>, CreateViewTemplate>
> = {
  document: {
    title: '新文档',
    markdown: '# 新文档\n\n开始记录内容。',
  },
}
