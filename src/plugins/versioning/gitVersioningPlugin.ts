import type { NotebookPlugin } from '../pluginRegistry'

export const gitVersioningPlugin: NotebookPlugin = {
  id: 'git-versioning',
  name: 'Git 版本管理',
  version: '0.1.0',
  description: '把知识库文档导出为稳定快照，为后续 Git commit、diff、history 和 restore 提供基础。',
  capabilities: ['document:read', 'document:export', 'repository:read', 'repository:write'],
  commands: [
    {
      id: 'git-versioning.snapshot-current',
      title: '生成当前文档快照',
      description: '将当前文档转换为 Markdown/JSON 快照，后续可交给 Git 仓库提交。',
    },
    {
      id: 'git-versioning.init-repository',
      title: '初始化版本仓库',
      description: '为当前知识库创建 Git 版本仓库。下一阶段接入真实 git init。',
    },
  ],
}
